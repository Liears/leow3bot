// SubAgent 运行器：subagent 工具的 execute() 背后的一切（设计见 docs/subagent-design.md §5）。
// 职责：护栏（prompt 校验 / 并发闸 / 重复派发检测）→ 组装隔间（独立 messages +
// agent system + 白名单过滤工具表）→ runAgentLoop（静默 sink，内部事件全部丢弃）→
// 报告落盘截断。取消链：ESC 经 abortAllSubagents 中止全部运行中子代理。

import { runAgentLoop, type AgentLoopSink } from '../agent.js';
import { AGENTS_REGISTRY, type AgentDef } from './loader.js';
import { TOOLS_REGISTRY, type ToolDef, type ToolSchema } from '../tools.js';
import { getSkillListing } from '../skills.js';
import {
  MODEL, getSubagentModel,
  MAX_SUBAGENT_TURNS, MAX_SUBAGENT_TURNS_HARD, MAX_CONCURRENT_SUBAGENTS, SUBAGENT_REPORT_MAX_CHARS,
} from '../config.js';
import { persistToolOutput } from '../lib/persist.js';
import { subagentStart, subagentUpdate, subagentEnd } from '../store.js';
import { summarizeToolInput } from '../executor.js';
import type { AgentLoopResult, AgentLoopOpts } from '../agent.js';
import type { MessageParam } from '../types.js';

// —— 并发控制：运行中登记（ESC 中断用）+ 信号量（同时运行上限，超额排队）——
const runningAgents = new Map<string, AbortController>();
let runningSeq = 0;

/** ESC 中止全部子代理（含排队中——controller 先建，启动时即检中止；App.tsx 调用）。 */
export function abortAllSubagents(): void {
  for (const c of runningAgents.values()) c.abort();
}

// —— 并发信号量：超额自动排队而非拒绝 ——
// 前台阻塞语境下排队严格优于拒绝：拒绝需要模型下一轮重发（多付一次 LLM 往返
// + 重写任务书），排队零浪费。原「DA 式拒绝」设计据此废弃（实测一轮回派 4 个、
// 第 4 个被拒后模型确实要多跑一轮补发）。
let runningCount = 0;
const slotQueue: Array<() => void> = [];

export async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (runningCount >= MAX_CONCURRENT_SUBAGENTS) {
    await new Promise<void>(resolve => slotQueue.push(resolve));
  }
  runningCount++;
  try {
    return await fn();
  } finally {
    runningCount--;
    slotQueue.shift()?.();
  }
}

// —— 重复派发检测（DA 方案的单任务简化版）：同会话内完全相同的任务文本再次
//    派发 → 拒绝并提示。防「模型嘴上说做 B，参数里复制的是 A」的实录事故。
//    记录时机 = 实际启动（过全部护栏 + 拿到槽位之后）——从未开始的任务
//   （工具集报错、排队中被中止）不占坑，重发不误伤。 ——
const DISPATCH_TTL_MS = 30 * 60 * 1000;
const dispatchHistory: Array<{ prompt: string; at: number }> = [];

export function checkDuplicateDispatch(prompt: string): string | null {
  const now = Date.now();
  while (dispatchHistory.length && now - dispatchHistory[0].at > DISPATCH_TTL_MS) dispatchHistory.shift();
  if (dispatchHistory.some(h => h.prompt === prompt)) {
    return `疑似重复派发：本会话已委派过完全相同的任务描述。若是重试失败任务，请在 prompt 中注明差异（如"重做：…，上次卡在 X"）；若是新任务，请写出与上次不同的范围`;
  }
  return null;
}

export function recordDispatch(prompt: string): void {
  dispatchHistory.push({ prompt, at: Date.now() });
}

// —— 工具集组装：白名单过滤 + 强制剔除（递归/交互类）+ 未知工具名报错 ——
// 强制移除：subagent（v1 不嵌套）、ask（子代理不能向用户提问——主对话阻塞在
// 看不见的提问上是最差体验）。白名单只收窄不扩展。
const FORCE_REMOVE_TOOLS = new Set(['subagent', 'ask']);

// —— per-agent 工具包装 ①：只读闸（方案 B，设计文档 §5.3）——
// 白名单不含 edit/write 的代理 = 只读意图 → bash 加写形态正则闸。拦得住明显写法
// （重定向/写命令/sed -i/find -delete）；拦不住解释器字符串内的写（如 python -c
// "open(...)"），由子代理 prompt 铁律 + 全局 deny 黑名单兜底，AST 静态保证是 v2。
// 误伤时错误信息教模型换写法（引号包裹 / grep -F）。/dev/null 降噪例外放行。
const WRITE_SHAPE = /(^|[\s;&|(])(>>?)\s*(?!\/dev\/null)|(^|[\s;&|(])(touch|rm|rmdir|mv|cp|mkdir|tee|truncate|shred|ln|chmod|chown|install|dd)\s|sed\s+[^;|]*-i|find\s+[^;|]*(-delete|-exec)/;

function wrapReadOnlyBash(def: ToolDef): ToolDef {
  return {
    ...def,
    function: async (args: Record<string, unknown>) => {
      const cmd = String(args.command ?? '');
      if (WRITE_SHAPE.test(cmd)) {
        return {
          type: 'error' as const,
          message: '⛔ 只读代理禁止写操作（检测到重定向/写命令）。查含 > < 的内容请用引号包裹参数或 grep -F；确需写文件的任务请交给主对话处理',
        };
      }
      return def.function(args);
    },
  };
}

interface Toolset {
  registry: Record<string, ToolDef>;
  schemas: ToolSchema[];
  error?: string;
}

export function buildToolset(def: AgentDef): Toolset {
  const names = def.tools ?? Object.keys(TOOLS_REGISTRY);
  // 只读意图判定：显式白名单且不含写类工具（缺省全量不算只读——有写工具的代理不算）
  const readOnly = def.tools !== undefined && !def.tools.includes('edit') && !def.tools.includes('write');
  const registry: Record<string, ToolDef> = {};
  const schemas: ToolSchema[] = [];
  const unknown: string[] = [];
  for (const n of names) {
    if (FORCE_REMOVE_TOOLS.has(n)) continue;
    const d = TOOLS_REGISTRY[n];
    if (!d) { unknown.push(n); continue; }
    registry[n] = readOnly && n === 'bash' ? wrapReadOnlyBash(d) : d;
    schemas.push(d.schema);
  }
  // 未知工具名在启动时报错而非静默丢弃（CC 教训：零工具/丢工具子代理会空转）
  if (unknown.length) {
    return { registry, schemas, error: `agent "${def.name}" 工具白名单含未注册工具: ${unknown.join(', ')}——请修正定义文件（${def.path}）` };
  }
  if (!Object.keys(registry).length) {
    return { registry, schemas, error: `agent "${def.name}" 过滤后工具集为空` };
  }
  return { registry, schemas };
}

// —— 子代理 system 组装：agent 正文 + skill 清单 + web 指引 + 环境块
//    （与主对话 buildSystem 同构——子代理有 skill/web 工具就必须知道它们存在）——
export function buildSubagentSystem(def: AgentDef, registry: Record<string, ToolDef>): string {
  const parts: string[] = [def.content];
  const skillListing = getSkillListing();
  if (skillListing) parts.push(skillListing);
  const webParts: string[] = [];
  if ('web_search' in registry) webParts.push('web_search（联网搜索最新信息，返回标题/URL/摘要）');
  if ('web_fetch' in registry) webParts.push('web_fetch（读取指定 URL 的网页正文）');
  if (webParts.length) {
    parts.push(`可用 web 工具：${webParts.join('、')}。需要实时信息、最新数据、或用户问及网页内容时使用；回答末尾用 markdown 链接引用来源。`);
  }
  parts.push(`## 环境\n工作目录: ${process.cwd()}\n平台: ${process.platform}\n当前日期: ${new Date().toISOString().slice(0, 10)}`);
  return parts.join('\n\n');
}

// 模型解析顺序（设计文档 §4.3）：agent 定义 frontmatter > /subagent 配置 > 继承主模型
export function resolveSubagentModel(def: AgentDef): string {
  return def.model ?? getSubagentModel() ?? MODEL;
}

// —— 静默 sink 基底：子代理内部事件/流式输出全部丢弃（主 scrollback 零污染）——
export const SILENT_SINK: AgentLoopSink = {
  event: () => {},
  phase: () => {},
  usage: () => {},
  error: () => {},
  text: () => {},
  thinking: () => {},
  commitThinking: () => {},
  endText: () => {},
};

/** 工具入参摘要复用 executor 的实现（见 executor.summarizeToolInput）。 */

/**
 * 状态面板 sink（CC 式动态面板）：基底全静默，仅把「看得见它在干活」的两类信号
 * 转发给主 store 的动态区（不进 scrollback，不碰 phase——主循环的 tool_running 不被扰动）：
 *   tool_start → activity 行（工具名 + 入参摘要）
 *   usage      → 轮数计（每轮 LLM 结束触发一次）
 * 面板行的登记/移除由 runSubagent 生命周期负责（subagentStart/subagentEnd）。
 */
export function makeSubagentSink(key: string): AgentLoopSink {
  let rounds = 0;
  let toolCalls = 0;
  return {
    ...SILENT_SINK,
    event: (item) => {
      if (item.kind === 'tool_start') {
        toolCalls++;
        const brief = summarizeToolInput(item.call);
        subagentUpdate(key, { activity: `${item.call.name}${brief ? `: ${brief}` : ''}`, toolCalls });
      }
    },
    usage: () => {
      rounds++;
      subagentUpdate(key, { rounds });
    },
  };
}

function firstLine(s: string): string {
  const line = s.split('\n').map(t => t.trim()).find(t => t && !t.startsWith('#'));
  return line ? line.slice(0, 120) : '';
}

// 结果包装：output 供 UI ⎿ 行摘要（summarizeResult 优先取 output，防 JSON 泄露全文）；
// report 是回传给主模型的报告正文；超长落盘 + 截断提示（主上下文零污染）。
export function packageResult(def: AgentDef, r: AgentLoopResult, desc: string | undefined, model: string): Record<string, unknown> | { type: 'error'; message: string } {
  if (r.status === 'error') {
    return {
      type: 'error',
      message: `子代理 ${def.name} 执行失败（${r.rounds} 轮后）：${r.error ?? '未知错误'}` +
        (r.finalText ? `\n中断前的部分输出（未完成，勿当完整结论）：\n${r.finalText.slice(0, 800)}` : ''),
    };
  }
  // 残次品不装完整结论：done 但零输出 → 如实报错（设计文档 §9）
  if (!r.finalText.trim()) {
    return {
      type: 'error',
      message: `子代理 ${def.name} 未产生任何报告输出（status=${r.status}，${r.rounds} 轮/${r.toolCalls} 次工具）——任务未完成，请重派或换方式`,
    };
  }
  // 结构契约校验：done 且定义了 reportMarker 的，最终输出须含标记——
  // 缺失 = 疑似"进度旁白碰巧结束回合"（实测：GLM 长重复任务中途输出
  // "继续第 8 页："后停止，旁白被当报告回传）→ 按未完成错误返回，带部分输出
  if (r.status === 'done' && def.reportMarker && !r.finalText.includes(def.reportMarker)) {
    return {
      type: 'error',
      message: `子代理 ${def.name} 提前停止：最终输出不是规范报告（应以「${def.reportMarker}」起头），疑似进度旁白后结束回合。` +
        `部分输出（未完成，勿当结论）：\n${r.finalText.slice(0, 1200)}\n——请重派该任务，可在任务书中指定从已读部分之后继续`,
    };
  }
  // 状态内带：report 正文首行标注状态与规模——主模型可见完整性
  //（UI 的 output 行不进上下文，状态必须内带才能到达主模型）
  const statusLabel = r.status === 'done'
    ? `完成（${r.rounds} 轮/${r.toolCalls} 次工具）`
    : r.status === 'interrupted' ? '被中断，输出不完整' : '达轮次上限，输出可能不完整';
  let report = `[子代理 ${def.name} · ${statusLabel}]\n\n${r.finalText}`;
  let persistPath: string | undefined;
  if (report.length > SUBAGENT_REPORT_MAX_CHARS) {
    persistPath = persistToolOutput('subagent-report', report);
    report = report.slice(0, SUBAGENT_REPORT_MAX_CHARS) +
      `\n\n[报告过长已截断，全文 ${r.finalText.length} 字符${persistPath ? `，已保存至 ${persistPath}（可用 read 工具读取）` : ''}]`;
  }
  return {
    type: 'task',
    output: `${statusLabel}：${firstLine(r.finalText) || desc || ''}`,
    report,
    agent: def.name,
    model,
    rounds: r.rounds,
    toolCalls: r.toolCalls,
    status: r.status,
    ...(persistPath ? { persistPath } : {}),
  };
}

/**
 * subagent 工具入口。被 executor 调用（concurrencySafe → 相邻多个 subagent 调用
 * 经批次 Promise.all 并行）。全程不触碰主 store/autosave——静默运行，只回结果。
 */
export async function runSubagent(input: { prompt?: unknown; agent_type?: unknown; description?: unknown }): Promise<unknown> {
  const prompt = String(input.prompt ?? '').trim();
  const agentType = String(input.agent_type ?? 'explore');
  const desc = typeof input.description === 'string' ? input.description : undefined;

  // 护栏 1：prompt 自包含校验（子代理看不到主对话，过短的 prompt 必然瞎做）
  if (prompt.length < 10) {
    return { type: 'error', message: 'prompt 过短（<10 字符）。子代理看不到主对话历史——任务描述必须自包含：目标、范围、必要背景、期望输出格式' };
  }
  // 护栏 2：类型存在性
  const def = AGENTS_REGISTRY.get(agentType);
  if (!def) {
    const available = [...AGENTS_REGISTRY.keys()].join(', ') || '无';
    return { type: 'error', message: `未知子代理类型: ${agentType}。可用: ${available}` };
  }
  // 护栏 3：重复派发（只查不记——记录在实际启动时，见 withSlot 内）
  const dup = checkDuplicateDispatch(prompt);
  if (dup) return { type: 'error', message: dup };
  // 护栏 4：工具集校验
  const toolset = buildToolset(def);
  if (toolset.error) return { type: 'error', message: toolset.error };

  // 组装隔间：全新 messages + 子代理 system + 过滤后工具表。
  // 取消链：controller 先于排队创建并登记——排队中被 ESC 也能停（启动即检中止）。
  // 信号量：同时运行上限 3，超额自动排队；面板行在实际启动时才登记。
  const messages: MessageParam[] = [{ role: 'user', content: prompt }];
  const model = resolveSubagentModel(def);
  const controller = new AbortController();
  const key = `#${++runningSeq}`;
  runningAgents.set(key, controller);
  try {
    return await withSlot(async () => {
      if (controller.signal.aborted) {
        return packageResult(def, { status: 'interrupted', finalText: '', rounds: 0, toolCalls: 0, usage: null, error: null }, desc, model);
      }
      recordDispatch(prompt); // 实际启动才算占坑（工具集报错/排队中止的重发不误伤）
      subagentStart({
        key, name: def.name,
        desc: desc || prompt.replace(/\s+/g, ' ').slice(0, 40),
        rounds: 0, toolCalls: 0, activity: '启动中…', startedAt: Date.now(),
      });
      try {
        const result = await runAgentLoop({ current: null }, {
          messages,
          system: buildSubagentSystem(def, toolset.registry),
          tools: toolset.schemas,
          registry: toolset.registry,
          model,
          externalSignal: controller.signal,
          maxRounds: Math.min(def.maxTurns ?? MAX_SUBAGENT_TURNS, MAX_SUBAGENT_TURNS_HARD),
          sink: makeSubagentSink(key),
          autosave: false,
          interactive: false, // 子代理语境：confirm 自动拒绝 + 内部工具不登记通用打点（专属行已覆盖）
        } as AgentLoopOpts);
        return packageResult(def, result, desc, model);
      } finally {
        subagentEnd(key);
      }
    });
  } finally {
    runningAgents.delete(key);
  }
}
