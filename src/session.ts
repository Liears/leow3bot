// 会话持久化（移植 session.py）。~/.leow3bot/sessions/，current_session.json 覆盖式自动保存。

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { LEOW3BOT_HOME } from './config.js';
import type { ContentBlock, MessageContent, MessageParam } from './types.js';

const SESSION_DIR = path.join(LEOW3BOT_HOME, 'sessions');
try { mkdirSync(SESSION_DIR, { recursive: true }); } catch { /* noop */ }

// 项目隔离：每个项目（git root，无 git 则 cwd）独立一份 autosave，互不串。
function findProjectRoot(): string {
  try {
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' });
    if (r.status === 0 && r.stdout) return r.stdout.trim();
  } catch { /* noop */ }
  return process.cwd();
}
export const PROJECT_ROOT = findProjectRoot();
const PROJECT_HASH = createHash('sha256').update(PROJECT_ROOT).digest('hex').slice(0, 12);
const CURRENT_FILE = path.join(SESSION_DIR, `current_${PROJECT_HASH}.json`);
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
    name: genName(messages),
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
  const n = name ?? genName(messages);
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
