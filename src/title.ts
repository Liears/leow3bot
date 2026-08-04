// 会话主题后台生成：轻量 LLM 调用为当前对话生成一句话中文主题，
// 写回会话 name（resume 列表快速定位）。fire-and-forget 不阻塞主对话；
// 按「新增 3 条用户消息」节流 + pending 互斥，失败静默（下轮再试）。

import { getClient } from './llm.js';
import { MODEL } from './config.js';
import { autosaveSession, setSessionTitle, getSessionTitle } from './session.js';
import type { MessageParam } from './types.js';

let lastTriggerUserCount = 0; // 上次触发时的 user 消息数
let pending = false;

// 对话文本化摘要（生成主题的输入）：首条 user 消息 + 最近 6 条消息，裁剪到 ~4000 字符
function buildBrief(messages: MessageParam[]): string {
  const parts: string[] = [];
  const firstUser = messages.find(m => m.role === 'user');
  if (firstUser) parts.push(`[开头] ${textOf(firstUser, 300)}`);
  for (const m of messages.slice(-6)) {
    if (m.role === 'user') parts.push(`[用户] ${textOf(m, 200)}`);
    else if (m.role === 'assistant') {
      const t = textOf(m, 200);
      if (t) parts.push(`[助手] ${t}`);
    }
  }
  return parts.join('\n').slice(0, 4000);
}

function textOf(m: MessageParam, max: number): string {
  const c = m.content;
  if (typeof c === 'string') return c.slice(0, max);
  if (!Array.isArray(c)) return '';
  const parts: string[] = [];
  for (const b of c as Array<{ type?: string; text?: unknown }>) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') parts.push(String(b.text ?? ''));
    else if (b.type === 'tool_use') parts.push(`[调用 ${(b as { name?: string }).name ?? ''}]`);
  }
  return parts.join(' ').slice(0, max);
}

async function generateTitle(messages: MessageParam[]): Promise<string | null> {
  const brief = buildBrief(messages);
  const r = await getClient().messages.create({
    model: MODEL,
    max_tokens: 60,
    temperature: 0.3,
    messages: [{
      role: 'user',
      content: `为下面的对话生成一句话主题，要求：20 字以内、中文（专有名词如产品名/文件名/命令保留原文）、能概括核心任务。直接输出主题，不要解释或加引号。\n\n${brief}`,
    }],
  } as never);
  const text = ((r as { content?: Array<{ type?: string; text?: string }> }).content ?? [])
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .join(' ')
    .trim();
  if (!text) return null;
  return text.replace(/^["'「『]|["'」』]$/g, '').slice(0, 40);
}

/**
 * 按节流条件后台更新主题（调用方每轮 LLM 完成后调用，不 await）。
 * 首次（无主题）至少 1 条消息即触发；已有主题则每新增 3 条 user 消息刷新。
 */
export function maybeUpdateTitle(messages: MessageParam[]): void {
  if (pending || !messages.length) return;
  const userCount = messages.filter(m => m.role === 'user').length;
  const need = getSessionTitle() === null
    ? userCount >= 1
    : userCount - lastTriggerUserCount >= 3;
  if (!need) return;
  pending = true;
  void (async () => {
    try {
      const title = await generateTitle(messages);
      if (title) {
        setSessionTitle(title);
        autosaveSession(messages); // 立即用新主题重写 autosave（等下次 autosave 可能太晚）
      }
    } catch { /* 端点异常静默，下轮再试 */ }
    pending = false;
    lastTriggerUserCount = userCount;
  })();
}
