// Agent 核心：handleSubmit（命令/图片/对话分发）+ runTurn（多轮工具循环）。

import { callLLMStream } from './llm.js';
import {
  commit, appendText, appendThinking, flushText, commitThinking, resetMarkdown, setPhase, setUsageTiming,
  setError, getState, toggleCtx, togglePerf, toggleThinking,
} from './store.js';
import { SYSTEM_PROMPT, MAX_TOOL_ROUNDS, MAX_VIEWS_PER_ROUND } from './config.js';
import { getSkillListing } from './skills.js';
import { parseCommand, handleCommand, type CmdCtx } from './commands.js';
import { TOOLS_SCHEMAS, TOOLS_REGISTRY } from './tools.js';
import { partitionToolCalls, executeBatch, buildToolResultBlock, flushToolResults } from './executor.js';
import { autosaveSession } from './session.js';
import { evictOldImages, evictPreviousTurnImages, IMG_EVICTED_MARKER_TOOL, IMG_EVICTED_MARKER_PASTE } from './compaction.js';
import { maybeUpdateTitle } from './title.js';
import type { MessageParam, ContentBlock, ToolResultBlock, ToolCall, Usage, Timing } from './types.js';

export interface PastedImg { data: Buffer; mediaType: string; dims: string }

export const abortRef: { current: AbortController | null } = { current: null };

const messages: MessageParam[] = [];
let system = SYSTEM_PROMPT;

export function getMessages(): MessageParam[] { return messages; }
export function clearMessages(): void { messages.length = 0; }
export function setMessages(m: MessageParam[]): void { messages.length = 0; messages.push(...m); }
export function setSystem(s: string): void { system = s; }
export function getSystem(): string { return system; }

// 构建 system prompt（SYSTEM_PROMPT + skill listing + web 工具指引）。
// enable/disable skill 或运行时 disableTool 后调 setSystem(buildSystem()) 重算。
export function buildSystem(): string {
  const skillListing = getSkillListing();
  const webParts: string[] = [];
  if ('web_search' in TOOLS_REGISTRY) webParts.push('web_search（联网搜索最新信息，返回标题/URL/摘要）');
  if ('web_fetch' in TOOLS_REGISTRY) webParts.push('web_fetch（读取指定 URL 的网页正文）');
  const webGuide = webParts.length
    ? `可用 web 工具：${webParts.join('、')}。需要实时信息、最新数据、或用户问及网页内容时使用；回答末尾用 markdown 链接引用来源。`
    : '';
  return SYSTEM_PROMPT + (skillListing ? '\n\n' + skillListing : '') + (webGuide ? '\n\n' + webGuide : '');
}

function appendUserMessage(text: string): void {
  // 角色合并（对齐 Python _append_user_message）
  const last = messages[messages.length - 1];
  if (last && last.role === 'user') {
    const c = last.content;
    if (typeof c === 'string') last.content = c ? [{ type: 'text', text: c }] : [];
    else if (!Array.isArray(c)) last.content = [];
    (last.content as ContentBlock[]).push({ type: 'text', text });
  } else {
    messages.push({ role: 'user', content: text });
  }
}

function makeCtx(): CmdCtx {
  const s = getState();
  return {
    showCtx: s.showCtx, showPerf: s.showPerf, showThinking: s.showThinking,
    toggleCtx, togglePerf, toggleThinking, clearMessages, getMessages, setMessages,
  };
}

interface Outcome {
  type: 'done' | 'tool_call' | 'interrupted';
  assistant_msg: MessageParam;
  tool_calls?: ToolCall[];
  usage: Usage | null;
  timing: Timing;
}

// 命令 / 图片 / 对话分发
export async function handleSubmit(text: string, images: PastedImg[], exit: () => void): Promise<void> {
  const parsed = parseCommand(text);
  if (parsed) {
    const r = await handleCommand(parsed.cmd, parsed.args, makeCtx());
    if (r?.exit) { exit(); return; }
    if (r?.output) commit({ kind: 'system', text: r.output, tone: r.tone ?? 'muted' });
    autosaveSession(messages);
    return;
  }
  if (text.trim().toLowerCase() === 'q') { exit(); return; }

  // push user message（图文 或 纯文本）
  if (images.length) {
    const content: ContentBlock[] = [];
    if (text.trim()) content.push({ type: 'text', text });
    for (const img of images) {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data.toString('base64') } });
    }
    messages.push({ role: 'user', content });
    commit({ kind: 'user', text: text.trim() ? text : '[图片]' });
  } else {
    appendUserMessage(text);
    commit({ kind: 'user', text });
  }
  void runTurn(abortRef);
}

// 图片轮的"结构证据"判定：相邻 user 消息（前条=粘贴图；后条=工具结果图）里
// 存在 image 块或驱逐占位标记。用结构而非工具名判定——覆盖旧会话（read 读图
// 时代）且跨轮持久（图片被驱逐后标记仍在，观察 thinking 不会在下一轮被误剥）。
function blockHasImageEvidence(b: ContentBlock): boolean {
  if (!b || typeof b !== 'object') return false;
  if (b.type === 'image') return true;
  if (b.type === 'text') {
    const t = (b as { text?: unknown }).text;
    return typeof t === 'string' && (t.includes(IMG_EVICTED_MARKER_TOOL) || t.includes(IMG_EVICTED_MARKER_PASTE));
  }
  if (b.type === 'tool_result') {
    const c = (b as { content?: unknown }).content;
    if (Array.isArray(c)) return (c as ContentBlock[]).some(blockHasImageEvidence);
    if (typeof c === 'string') return c.includes(IMG_EVICTED_MARKER_TOOL) || c.includes(IMG_EVICTED_MARKER_PASTE);
  }
  return false;
}

function msgHasImageEvidence(m: MessageParam | undefined): boolean {
  if (!m || m.role !== 'user' || !Array.isArray(m.content)) return false;
  return (m.content as ContentBlock[]).some(blockHasImageEvidence);
}

// 剥离历史 assistant 消息中的 thinking 块——**条件化**：
//   图片轮（相邻 user 消息有图片证据：粘贴图 / 工具结果图 / 驱逐标记）→ thinking 保留。
//     它是对图片细节的观察记录（不可再生载体），驱逐图片后是唯一在场记忆。
//   文本/普通工具轮 → thinking 剥离。纯脚手架，结论已凝结在 text/tool_use 里，
//     但每次请求全额计入 input_tokens（实测 Qwen 兼容层 1:1 计费）。
// 载体决定去留：图片的信息载体是 thinking（48K）而非原图（270K），保留前者驱逐后者。
// 只在新用户轮入口调用；循环内新产生的 thinking 保留（Anthropic 契约：当前工具循环
// 的 thinking 随 tool_use 回传，signature 校验链）。
export function stripHistoricalThinking(messages: MessageParam[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    if (msgHasImageEvidence(messages[i - 1]) || msgHasImageEvidence(messages[i + 1])) continue;
    const filtered = (m.content as ContentBlock[]).filter(b => b && typeof b === 'object' && b.type !== 'thinking');
    if (filtered.length === 0) {
      // 中断的 turn 可能只有 thinking 块——剥离后为空。空 content 数组部分严格端点会
      // 400，用占位文本块保持消息结构（assistant 无配对约束，占位即可）。
      m.content = [{ type: 'text', text: '(此轮无正文输出)' }];
    } else if (filtered.length !== (m.content as ContentBlock[]).length) {
      m.content = filtered;
    }
  }
}

// 修复中断 turn 遗留的孤儿 tool_use：无配对 tool_result 的 tool_use 块会让严格端点
// 400（同款契约问题）。为每个未应答的 tool_use 合成 tool_result 注入其后方 user 消息。
export function repairInterruptedToolCalls(messages: MessageParam[]): void {
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const b of m.content as ContentBlock[]) {
      if (b && typeof b === 'object' && b.type === 'tool_result') {
        answered.add(String((b as { tool_use_id?: string }).tool_use_id ?? ''));
      }
    }
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const unanswered = (m.content as ContentBlock[]).filter(
      b => b && typeof b === 'object' && b.type === 'tool_use' && !answered.has(String((b as { id?: string }).id ?? '')),
    );
    if (!unanswered.length) continue;
    const synth = unanswered.map(b => ({
      type: 'tool_result' as const,
      tool_use_id: String((b as { id?: string }).id ?? ''),
      content: '此调用已被中断，无结果',
    }));
    const next = messages[i + 1];
    if (next && next.role === 'user' && Array.isArray(next.content)) {
      (next.content as ContentBlock[]).unshift(...synth);
    } else {
      messages.splice(i + 1, 0, { role: 'user', content: synth });
    }
    for (const b of unanswered) answered.add(String((b as { id?: string }).id ?? ''));
  }
}

// 多轮工具循环（对齐 Python process_user_turn）
async function runTurn(ref: { current: AbortController | null }): Promise<void> {
  setError(null); // 新回合清除上一轮的错误提示（此前设置后永不清除，红字常驻）
  stripHistoricalThinking(messages);
  repairInterruptedToolCalls(messages);
  // 轮入口驱逐历史图片（图片是当轮工作材料，观察已由图片轮 thinking 承载）。
  // 必须在 strip 之后：strip 依赖粘贴图的存在判定图片轮、保留其 thinking。
  const evictedImages = evictPreviousTurnImages(messages);
  if (evictedImages > 0) {
    commit({ kind: 'system', tone: 'muted', text: `🗜️ 已释放 ${evictedImages} 张历史图片（观察记录保留，原图可重新 view）` });
  }
  let round = 0;
  // turn 累加：整个 turn（含多次工具调用 LLM）的总 usage/timing，而非单次 LLM。
  // input/cache 取最后一次（当前 context），output/decode 累加，ttft 取首次（用户感知首 token）。
  let turnOutput = 0;
  let turnDecode = 0;
  let firstTtft: number | null = null;
  let lastUsage: Usage | null = null;
  const turnStart = performance.now();
  let roundRetries = 0; // 空响应等可重试错误的已重试次数
  let prunedImages = false; // 是否已做过降级（释放旧图）重试
  while (true) {
    round++;
    if (round > MAX_TOOL_ROUNDS) {
      commit({ kind: 'system', text: `已达最大轮次限制（${MAX_TOOL_ROUNDS}），停止`, tone: 'warn' });
      setPhase('idle');
      return;
    }

    // 即看即释：上一轮消费过的图片换占位（观察已在该轮 thinking 里），只保留
    // 最新一批待消费。马拉松中图片占用恒定 ≈ 一个批次，这是放开分辨率的前提。
    evictOldImages(messages, 1);

    const controller = new AbortController();
    ref.current = controller;
    setPhase('thinking');

    let outcome: Outcome | null = null;
    try {
      for await (const ev of callLLMStream(messages, TOOLS_SCHEMAS, system, controller.signal)) {
        if (ev.type === 'text') {
          // 回复开始：思考 commit 进 scrollback 保留，再清窗口
          commitThinking();
          appendText(ev.text);
        } else if (ev.type === 'thinking') {
          appendThinking(ev.text); // 内部按 showThinking 决定是否进 scrollback
        } else {
          // done / tool_call / interrupted：思考 commit + flush + 累加 turn 指标。
          commitThinking();
          flushText();
          resetMarkdown();
          if (ev.usage) {
            turnOutput += (ev.usage.output_tokens ?? 0);
            lastUsage = ev.usage;
          }
          if (ev.timing) {
            if (firstTtft === null && ev.timing.ttft != null) firstTtft = ev.timing.ttft;
            turnDecode += (ev.timing.decode_time ?? 0);
          }
          // turn 视图：input/cache 取最后（当前 context），output 累加；ttft 首次，decode 累加，total 整个 turn
          const turnUsage: Usage | null = lastUsage ? { ...lastUsage, output_tokens: turnOutput } : ev.usage;
          const turnTiming: Timing = {
            ttft: firstTtft,
            decode_time: turnDecode > 0 ? turnDecode : null,
            total: performance.now() - turnStart,
          };
          setUsageTiming(turnUsage, turnTiming);
          messages.push(ev.assistant_msg);
          maybeUpdateTitle(messages); // 后台生成会话主题（fire-and-forget，不阻塞）
          outcome = ev;
          break;
        }
      }
    } catch (e) {
      // 可重试错误（如 vLLM 多图请求返回空响应）：重试 2 次，仍失败才报错。
      // 不重试本轮不计轮次（round 回退，continue 后再 ++）。
      if ((e as { retryable?: boolean }).retryable === true && roundRetries < 2) {
        roundRetries++;
        round--;
        commit({ kind: 'system', tone: 'warn', text: `⚠️ ${(e as Error).message}——自动重试 ${roundRetries}/2` });
        await new Promise(r => setTimeout(r, 1500 * roundRetries)); // 退避：间歇性服务端故障（负载/显存波动）立刻重发易撞同一窗口
        continue;
      }
      // 降级重试：常规重试耗尽后，释放全部图片缩小请求（共享 GPU 服务器对大图片
      // payload 的视觉编码在压力下会被静默丢弃），再试最后一次。每个 turn 只降级一次。
      // keepRecent=0：即看即释后上下文本就只有当前批，降级连它也释放——
      // 牺牲当批可见性换会话存活，恢复后模型可重新 view。
      if ((e as { retryable?: boolean }).retryable === true && !prunedImages) {
        const n = evictOldImages(messages, 0);
        if (n > 0) {
          prunedImages = true;
          round--;
          commit({ kind: 'system', tone: 'warn', text: `⚠️ 连续空响应——已释放 ${n} 张较早的图片以缩小请求（路径在调用记录中，需要时可重新 view），降级重试` });
          continue;
        }
      }
      const msg = e instanceof Error ? e.message : String(e);
      setError(`[错误] ${msg}`);
      ref.current = null;
      setPhase('idle');
      return;
    }
    ref.current = null;
    roundRetries = 0; // 本轮成功，重置重试计数

    if (!outcome) { setPhase('idle'); return; }

    if (outcome.type === 'interrupted') {
      appendUserMessage('[Request interrupted by user]');
      commit({ kind: 'system', text: '已暂停 — 可继续输入', tone: 'muted' });
      setPhase('idle');
      return;
    }

    if (outcome.type === 'tool_call') {
      // 单轮 view 硬预算：即看即释的"图片占用 ≈ 一个批次"以批次有界为前提。
      // schema 软引导之外加执行侧上限——模型偶尔一轮发十几个 view，超出的延迟到
      // 下一轮（合成提示结果），防单轮大批量顶爆窗口/请求体。
      let viewBudget = MAX_VIEWS_PER_ROUND;
      const deferred: ToolCall[] = [];
      const capped = (outcome.tool_calls ?? []).filter(tc => {
        if (tc.name !== 'view') return true;
        if (viewBudget <= 0) {
          deferred.push(tc);
          return false;
        }
        viewBudget--;
        return true;
      });
      const batches = partitionToolCalls(capped);
      const allBlocks: ToolResultBlock[] = [];
      for (const batch of batches) {
        for (const tc of batch.calls) commit({ kind: 'tool_start', call: tc });
        // ask 工具内部 setPhase('ask_pending')；其他工具显示执行 spinner
        if (!(batch.calls.length === 1 && batch.calls[0].name === 'ask')) setPhase('tool_running');
        const results = await executeBatch(batch);
        for (const [tc, res] of results) {
          commit({ kind: 'tool_result', call: tc, result: res });
          allBlocks.push(buildToolResultBlock(tc, res));
        }
      }
      // 延迟的 view：合成提示结果（契约要求每个 tool_use 都有配对 tool_result）
      for (const tc of deferred) {
        commit({ kind: 'tool_start', call: tc });
        const res = { type: 'error' as const, message: `本单轮图片查看已达上限（${MAX_VIEWS_PER_ROUND} 张），本次调用已延迟未执行——请在下一轮分批继续（每批 ≤5 张更稳）` };
        commit({ kind: 'tool_result', call: tc, result: res });
        allBlocks.push(buildToolResultBlock(tc, res));
      }
      // 同一轮所有 tool_use 的结果必须合并成一条紧邻的 user 消息（Anthropic 契约：
      // tool_result 必须紧随 tool_use 出现在同一条消息里）。拆多条会被 DeepSeek
      // 等严格兼容端点以 400（tool_use without tool_result）拒绝。
      flushToolResults(allBlocks, messages);
      autosaveSession(messages);
      continue; // 下一轮 LLM
    }

    // done：最终文本回答
    autosaveSession(messages);
    setPhase('idle');
    return;
  }
}
