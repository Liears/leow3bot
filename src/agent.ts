// Agent 核心：handleSubmit（命令/图片/对话分发）+ runTurn（多轮工具循环）。

import { callLLMStream } from './llm.js';
import {
  commit, appendText, appendThinking, flushText, commitThinking, resetMarkdown, setPhase, setUsageTiming,
  setError, getState, toggleCtx, togglePerf, toggleThinking,
} from './store.js';
import { SYSTEM_PROMPT, MAX_TOOL_ROUNDS } from './config.js';
import { getSkillListing } from './skills.js';
import { parseCommand, handleCommand, type CmdCtx } from './commands.js';
import { TOOLS_SCHEMAS } from './tools.js';
import { partitionToolCalls, executeBatch, buildToolResultBlock, flushToolResults } from './executor.js';
import { autosaveSession } from './session.js';
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
// enable/disable skill 后调 setSystem(buildSystem()) 即时重算 listing。
const WEB_TOOLS_GUIDE =
  '可用 web 工具：web_search（联网搜索最新信息，返回标题/URL/摘要）、web_fetch（读取指定 URL 的网页正文）。\n' +
  '需要实时信息、最新数据、或用户问及网页内容时使用；回答末尾用 markdown 链接引用来源。';
export function buildSystem(): string {
  const skillListing = getSkillListing();
  return SYSTEM_PROMPT + (skillListing ? '\n\n' + skillListing : '') + '\n\n' + WEB_TOOLS_GUIDE;
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

// 多轮工具循环（对齐 Python process_user_turn）
async function runTurn(ref: { current: AbortController | null }): Promise<void> {
  let round = 0;
  // turn 累加：整个 turn（含多次工具调用 LLM）的总 usage/timing，而非单次 LLM。
  // input/cache 取最后一次（当前 context），output/decode 累加，ttft 取首次（用户感知首 token）。
  let turnOutput = 0;
  let turnDecode = 0;
  let firstTtft: number | null = null;
  let lastUsage: Usage | null = null;
  const turnStart = performance.now();
  while (true) {
    round++;
    if (round > MAX_TOOL_ROUNDS) {
      commit({ kind: 'system', text: `已达最大轮次限制（${MAX_TOOL_ROUNDS}），停止`, tone: 'warn' });
      setPhase('idle');
      return;
    }

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
          outcome = ev;
          break;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`[错误] ${msg}`);
      ref.current = null;
      setPhase('idle');
      return;
    }
    ref.current = null;

    if (!outcome) { setPhase('idle'); return; }

    if (outcome.type === 'interrupted') {
      appendUserMessage('[Request interrupted by user]');
      commit({ kind: 'system', text: '已暂停 — 可继续输入', tone: 'muted' });
      setPhase('idle');
      return;
    }

    if (outcome.type === 'tool_call') {
      const batches = partitionToolCalls(outcome.tool_calls ?? []);
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
