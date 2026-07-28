// 状态管理：createStore + useSyncExternalStore（复刻 CC state/store.ts）
// 核心契约：committed 只增（喂 <Static> 进原生 scrollback）；动态区字段每帧整体替换（ink diff）。

import { useSyncExternalStore } from 'react';
import type { CommittedItem, Usage, Timing, Meta } from './types.js';

export type Phase = 'idle' | 'thinking' | 'streaming' | 'tool_running' | 'ask_pending' | 'skills_picker';

export interface State {
  committed: CommittedItem[];      // 只增 → <Static> → 原生 scrollback
  streamingText: string;           // 动态区当前流式文本
  streamingThinking: string;       // 动态区当前思考流（/verbose 时显示）
  phase: Phase;
  usage: Usage | null;
  timing: Timing | null;
  showCtx: boolean;
  showPerf: boolean;
  showThinking: boolean;
  meta: Meta | null;                          // 启动元信息（StatusBar 常驻显示）
  mdInCode: boolean;                          // markdown 代码块状态（跨行跟踪 ```，逐行 commit 用）
  askResolver: ((s: string) => void) | null;  // ask 工具的临时 resolver
  error: string | null;
}

const initial: State = {
  committed: [], streamingText: '', streamingThinking: '', phase: 'idle',
  usage: null, timing: null, showCtx: true, showPerf: true, showThinking: true,
  meta: null, mdInCode: false, askResolver: null, error: null,
};

let state: State = initial;
const listeners = new Set<() => void>();

function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

export const getState = () => state;

// actions
export const commit = (item: CommittedItem) => set(s => ({ committed: [...s.committed, item] }));
export const commitMany = (items: CommittedItem[]) => set(s => ({ committed: [...s.committed, ...items] }));
// 流式逐字：按 \n 拆分，完整行原子 commit 进 scrollback，未完成段（最后无 \n 的一段）留动态区。
// 完整行 commit + 未完成段更新必须在同一次 set（原子），否则跨帧高度叠加导致跳动。
export const appendText = (delta: string) => set(s => {
  const lines = (s.streamingText + delta).split('\n');
  const pending = lines.pop() ?? '';
  const complete = lines;
  if (!complete.length) return { streamingText: pending, phase: 'streaming' as const };
  let inCode = s.mdInCode;
  const items: CommittedItem[] = complete.map(t => {
    const isFence = /^\s*(```|~~~)/.test(t);
    const code = inCode && !isFence; // 围栏行是边界不计 code；代码块内行 code=true
    if (isFence) inCode = !inCode;
    return { kind: 'assistant_line' as const, text: t, code };
  });
  return {
    committed: [...s.committed, ...items],
    streamingText: pending,
    mdInCode: inCode,
    phase: 'streaming' as const,
  };
});
// 思考逐行 commit 进 scrollback（像 appendText），不占动态区高度——
// 避免 ThinkingWindow 撑高动态区导致 spinner/Input/StatusBar 跳动或空白。
export const appendThinking = (delta: string) => set(s => {
  if (!s.showThinking) return {};
  const lines = (s.streamingThinking + delta).split('\n');
  const pending = lines.pop() ?? '';
  const complete = lines;
  if (!complete.length) return { streamingThinking: pending };
  const items = complete.map(t => ({ kind: 'thinking_line' as const, text: t }));
  return { committed: [...s.committed, ...items], streamingThinking: pending };
});
// flush 未完成段为最后一行（done/tool_call/interrupted 前调用）。原子，空则 no-op。
export const flushText = () => set(s => {
  if (!s.streamingText) return {};
  const isFence = /^\s*(```|~~~)/.test(s.streamingText);
  return {
    committed: [...s.committed, { kind: 'assistant_line' as const, text: s.streamingText, code: s.mdInCode && !isFence }],
    streamingText: '',
  };
});
// 重置 markdown 代码块状态（每个新回复开始前）
export const resetMarkdown = () => set({ mdInCode: false });
// 思考结束：commit 进 scrollback（保留可回看），再清空窗口。空则 no-op。
export const commitThinking = () => set(s => s.streamingThinking
  ? { committed: [...s.committed, { kind: 'thinking_line' as const, text: s.streamingThinking }], streamingThinking: '' }
  : {});
export const setPhase = (phase: Phase) => set({ phase });
export const setUsageTiming = (usage: Usage | null, timing: Timing | null) => set({ usage, timing });
export const toggleCtx = () => set(s => ({ showCtx: !s.showCtx }));
export const togglePerf = () => set(s => ({ showPerf: !s.showPerf }));
export const toggleThinking = () => set(s => ({ showThinking: !s.showThinking }));
export const setAskResolver = (r: ((s: string) => void) | null) => set({ askResolver: r });
export const setMeta = (m: Meta) => set({ meta: m });
export const setError = (e: string | null) => set({ error: e });

export function useStore(): State {
  return useSyncExternalStore(
    (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    getState,
    getState,
  );
}
