// 会话持久化（移植 session.py）。~/.leow3bot/sessions/，current_session.json 覆盖式自动保存。

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { LEOW3BOT_HOME } from './config.js';
import { commit, setUsageTiming } from './store.js';
import { setMessages, getSystem } from './agent.js';
import { countTokens } from './llm.js';
import { TOOLS_SCHEMAS } from './tools.js';
import type { CommittedItem, ContentBlock, MessageContent, MessageParam, ToolCall } from './types.js';

const SESSION_DIR = path.join(LEOW3BOT_HOME, 'sessions');
try { mkdirSync(SESSION_DIR, { recursive: true }); } catch { /* noop */ }

// 项目隔离：每个项目（git root，无 git 则 cwd）独立一份 autosave，互不串。
// --resume 恢复会话时会 chdir 到会话所属项目，项目状态需可刷新（refreshProject）。
function findProjectRoot(): string {
  try {
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' });
    if (r.status === 0 && r.stdout) return r.stdout.trim();
  } catch { /* noop */ }
  return process.cwd();
}
export let PROJECT_ROOT = findProjectRoot();
let PROJECT_HASH = createHash('sha256').update(PROJECT_ROOT).digest('hex').slice(0, 12);
let CURRENT_FILE = path.join(SESSION_DIR, `current_${PROJECT_HASH}.json`);

/** chdir 后重算项目根 / autosave 文件路径（恢复会话切换目录时调用）。 */
export function refreshProject(): void {
  PROJECT_ROOT = findProjectRoot();
  PROJECT_HASH = createHash('sha256').update(PROJECT_ROOT).digest('hex').slice(0, 12);
  CURRENT_FILE = path.join(SESSION_DIR, `current_${PROJECT_HASH}.json`);
}

// 会话主题（后台自动生成，见 title.ts）：会话名 / resume 列表的定位依据。
// 内存态，resume 会话时从文件 name 恢复为初始值。空串归一为 null（视为无主题）。
let sessionTitle: string | null = null;
export function setSessionTitle(t: string): void { sessionTitle = t && t.trim() ? t : null; }
export function getSessionTitle(): string | null { return sessionTitle; }
const CURRENT_PREFIX = 'current_';
const MAX_SESSIONS = 50;

export interface SessionMeta {
  filename: string;
  name: string;
  timestamp: string;
  message_count: number;
  filepath: string;
  is_current: boolean;         // 当前项目的 autosave 文件
  projectRoot: string;         // 会话所属项目
  is_current_project: boolean; // 是否属于当前项目
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function compressContent(content: MessageContent): MessageContent {
  if (typeof content === 'string' || !Array.isArray(content)) return content;
  return (content as ContentBlock[]).map(block => {
    if (!block || typeof block !== 'object') return block;
    if (block.type === 'image') {
      return {
        type: 'image' as const,
        source: { type: 'placeholder' as const, media_type: block.source.media_type ?? 'image/unknown', note: '图片数据已移除以节省空间' },
      };
    }
    if (block.type === 'tool_result' || block.type === 'tool_use') {
      const b = { ...block } as Record<string, unknown>;
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        b.content = compressContent(block.content as MessageContent);
      }
      if (block.type === 'tool_use' && block.input && typeof block.input === 'object') {
        const inp = { ...(block.input as Record<string, unknown>) };
        for (const k of Object.keys(inp)) {
          const v = inp[k];
          if (typeof v === 'string' && v.length > 10000 && v.startsWith('data:')) inp[k] = '[base64 data removed]';
        }
        b.input = inp;
      }
      return b as unknown as ContentBlock;
    }
    return block;
  }) as ContentBlock[];
}

function compressMessages(messages: MessageParam[]): MessageParam[] {
  return messages.map(m => ({ ...m, content: compressContent(m.content) }));
}

function genName(messages: MessageParam[]): string {
  for (const m of messages) {
    if (m.role === 'user') {
      let c: string;
      if (Array.isArray(m.content)) {
        c = (m.content as ContentBlock[]).filter(b => b.type === 'text').map(b => (b as { text: string }).text).join(' ');
      } else {
        c = String(m.content);
      }
      let title = c.slice(0, 30).replace(/\n/g, ' ').trim();
      if (c.length > 30) title += '...';
      return title || '空会话';
    }
  }
  return '空会话';
}

export function autosaveSession(messages: MessageParam[]): void {
  if (!messages.length) return;
  const data = {
    version: 1,
    timestamp: timestamp(),
    name: sessionTitle ?? genName(messages), // 有后台生成的主题则用主题
    projectRoot: PROJECT_ROOT,
    message_count: messages.length,
    messages: compressMessages(messages),
  };
  try { writeFileSync(CURRENT_FILE, JSON.stringify(data), 'utf-8'); } catch { /* noop */ }
}

export function clearAutosave(): void {
  try { if (existsSync(CURRENT_FILE)) unlinkSync(CURRENT_FILE); } catch { /* noop */ }
}

export function saveSession(messages: MessageParam[], name?: string): string {
  if (!messages.length) return '';
  const ts = timestamp();
  const n = name ?? sessionTitle ?? genName(messages);
  const data = { version: 1, timestamp: ts, name: n, projectRoot: PROJECT_ROOT, message_count: messages.length, messages: compressMessages(messages) };
  const fp = path.join(SESSION_DIR, `${ts}.json`);
  try { writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8'); } catch { return ''; }
  cleanupOldSessions();
  return fp;
}

export function loadSession(filepath: string): MessageParam[] | null {
  let p = filepath;
  if (!path.isAbsolute(p)) p = path.join(SESSION_DIR, filepath);
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, 'utf-8'));
    return (data.messages ?? null) as MessageParam[] | null;
  } catch { return null; }
}

// —— 会话恢复（仿 CC --resume / --continue）——

/** 按会话 id（文件名，可带可不带 .json，也接受完整路径）加载会话。 */
export function resumeSession(id: string): { messages: MessageParam[]; filepath: string; projectRoot: string; name: string } | null {
  let p = id;
  if (!p.endsWith('.json')) p += '.json';
  const fp = path.isAbsolute(p) ? p : path.join(SESSION_DIR, p);
  // 路径必须在 sessions 目录内（防相对路径穿越：resumeSession('../../foo')）
  const resolved = path.resolve(fp);
  if (!resolved.startsWith(path.resolve(SESSION_DIR) + path.sep)) return null;
  if (!existsSync(resolved)) return null;
  try {
    const data = JSON.parse(readFileSync(resolved, 'utf-8'));
    const messages = (data.messages ?? null) as unknown;
    // 只接受消息数组（畸形文件返回 null 而非让 setMessages 崩溃）
    if (!Array.isArray(messages)) return null;
    return {
      messages: messages as MessageParam[],
      filepath: resolved,
      projectRoot: String(data.projectRoot ?? ''),
      name: String(data.name ?? ''),
    };
  } catch { return null; }
}

/** 恢复当前项目最近会话：优先 autosave（current_<hash>.json），否则最近的快照。 */
export function resumeLatest(): { messages: MessageParam[]; filepath: string; projectRoot: string; name: string } | null {
  const current = path.join(SESSION_DIR, `current_${PROJECT_HASH}.json`);
  if (existsSync(current)) {
    const r = resumeSession(current);
    if (r) return r;
  }
  const latest = listSessions(20).find(s => s.is_current_project && !s.is_current);
  return latest ? resumeSession(latest.filename) : null;
}

// 提取 user 消息的文本（多 text 块拼接；无文本时按 [图片] 处理）
function userText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content as ContentBlock[]) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') parts.push(String((b as { text: unknown }).text));
    else if (b.type === 'image') parts.push('[图片]');
  }
  return parts.join(' ');
}

/**
 * 把会话消息重建为 committed 项（UI 完整恢复历史对话，与流式渲染一致）：
 * assistant thinking → thinking_line、text 按 \n 拆 assistant_line、tool_use → tool_start；
 * user 普通文本 → user；含 tool_result 的 user 消息 → tool_result 项（配对上方的 tool_start）。
 */
export function rebuildCommitted(messages: MessageParam[]): CommittedItem[] {
  const items: CommittedItem[] = [];
  for (const m of messages) {
    const content: ContentBlock[] = Array.isArray(m.content)
      ? (m.content as ContentBlock[])
      : [{ type: 'text', text: String(m.content) }];
    if (m.role === 'assistant') {
      for (const b of content as ContentBlock[]) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'thinking') {
          const t = String((b as { thinking: unknown }).thinking ?? '');
          if (t) items.push({ kind: 'thinking_line', text: t });
        } else if (b.type === 'text') {
          const t = String((b as { text: unknown }).text ?? '');
          if (!t) continue;
          for (const line of t.split('\n')) items.push({ kind: 'assistant_line', text: line, code: false });
        } else if (b.type === 'tool_use') {
          const tu = b as unknown as { id?: string; name?: string; input?: Record<string, unknown> };
          const call: ToolCall = { id: tu.id ?? '', name: tu.name ?? '', input: tu.input ?? {} };
          items.push({ kind: 'tool_start', call });
        }
      }
    } else {
      const blocks = content as ContentBlock[];
      const toolResults = blocks.filter(b => b && typeof b === 'object' && b.type === 'tool_result');
      if (toolResults.length) {
        for (const b of toolResults) {
          const tr = b as unknown as { tool_use_id?: string; content?: unknown };
          items.push({
            kind: 'tool_result',
            call: { id: tr.tool_use_id ?? '', name: '', input: {} },
            result: tr.content,
          });
        }
        // 工具轮后用户接着输入的文本会与 tool_result 合并进同一条 user 消息
        // （appendUserMessage 角色合并），恢复时也要渲染，否则 UI 静默丢失
        const text = userText(content);
        if (text.trim()) items.push({ kind: 'user', text });
      } else {
        const text = userText(content);
        items.push({ kind: 'user', text: text.trim() ? text : '[图片]' });
      }
    }
  }
  return items;
}

/** 恢复会话并把历史重建进 committed（启动 --resume / /load 共用）。 */
export function applyResume(messages: MessageParam[]): void {
  for (const item of rebuildCommitted(messages)) commit(item);
}

/**
 * 激活恢复的会话：若会话属于其他项目（projectRoot 与当前 cwd 不同），
 * chdir 到该目录并刷新项目状态（autosave 路径 / 项目 hash），
 * 再把消息注入上下文 + 历史重建进 committed。
 * 调用方随后需自行刷新 meta.cwd 与项目级 skill（见 main.tsx / SessionPicker）。
 */
export function activateResume(resumed: { messages: MessageParam[]; projectRoot: string }): void {
  const target = resumed.projectRoot;
  if (target && target !== process.cwd()) {
    try {
      if (existsSync(target)) {
        process.chdir(target);
        refreshProject();
      }
    } catch { /* chdir 失败不阻断恢复 */ }
  }
  setMessages(resumed.messages);
  applyResume(resumed.messages);
  void refreshUsageAfterResume(resumed.messages); // 恢复后立即显示上下文占用（不阻塞）
}

// 恢复会话后 usage 为 null，状态栏 Context 不显示——后台补一次上下文占用：
// 优先 countTokens 精确计数（模型 tokenizer），端点不支持则字符/4 粗估。
async function refreshUsageAfterResume(messages: MessageParam[]): Promise<void> {
  let input: number | null = null;
  try {
    input = await countTokens(getSystem(), messages, TOOLS_SCHEMAS);
  } catch { /* fallthrough */ }
  if (input == null) {
    input = Math.round(JSON.stringify(messages).length / 4);
  }
  setUsageTiming({ input_tokens: input, output_tokens: 0 }, null);
}

export function listSessions(limit = 10): SessionMeta[] {
  const sessions: SessionMeta[] = [];
  for (const f of readdirSync(SESSION_DIR)) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(SESSION_DIR, f);
    try {
      const data = JSON.parse(readFileSync(full, 'utf-8'));
      const pr = data.projectRoot ?? '';
      sessions.push({
        filename: f, name: data.name ?? '未命名', timestamp: data.timestamp ?? '',
        message_count: data.message_count ?? 0, filepath: full,
        is_current: f === `current_${PROJECT_HASH}.json`,
        projectRoot: pr,
        is_current_project: pr === PROJECT_ROOT,
      });
    } catch { /* skip */ }
  }
  sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return sessions.slice(0, limit);
}

function cleanupOldSessions(): void {
  const snaps = readdirSync(SESSION_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith(CURRENT_PREFIX))
    .map(f => path.join(SESSION_DIR, f));
  if (snaps.length <= MAX_SESSIONS) return;
  snaps.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  for (const f of snaps.slice(0, snaps.length - MAX_SESSIONS)) {
    try { unlinkSync(f); } catch { /* noop */ }
  }
}
