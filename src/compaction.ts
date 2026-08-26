// 消息压缩（移植 compaction.py + 修正两处 bug：image_url→image、role==tool→role==user+tool_result）

import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { ContentBlock, MessageParam } from './types.js';

const PERSIST_DIR = path.join(tmpdir(), 'leow3bot_analysis');
try { mkdirSync(PERSIST_DIR, { recursive: true }); } catch { /* noop */ }

function persistAnalysis(filename: string, analysis: string): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const p = path.join(PERSIST_DIR, `${safe}.txt`);
  try { writeFileSync(p, analysis, 'utf-8'); } catch { /* noop */ }
  return p;
}

/** 将已处理过的图片消息替换为轻量文本摘要。修正 Python bug：检测 image（非 image_url）。 */
export function compactMediaMessages(messages: MessageParam[]): number {
  let compacted = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    const hasMedia = (msg.content as ContentBlock[]).some(b => b.type === 'image');
    if (!hasMedia) continue;

    // 前一条 user(含 tool_result) 的工具信息
    let toolInfo = '';
    for (let j = i - 1; j >= 0; j--) {
      const mj = messages[j];
      if (Array.isArray(mj.content)) {
        const tr = (mj.content as ContentBlock[]).filter(b => b.type === 'tool_result');
        if (tr.length) {
          toolInfo = tr.map(b => String((b as { content: unknown }).content ?? '')).join(' ').slice(0, 500);
          break;
        }
      }
    }
    // 后一条 assistant 的分析摘要
    let analysis = '';
    for (let j = i + 1; j < messages.length; j++) {
      if (messages[j].role === 'assistant') {
        const c = messages[j].content;
        analysis = (Array.isArray(c)
          ? (c as ContentBlock[]).filter(b => b.type === 'text').map(b => (b as { text: string }).text).join(' ')
          : String(c)
        ).slice(0, 1000);
        break;
      }
    }

    let persistPath = '';
    if (analysis) {
      let fname = 'media';
      for (const word of toolInfo.split(/\s+/)) {
        if (word.includes('.') && word.includes('/')) { fname = path.basename(word.replace(/[，.)）]+$/, '')); break; }
      }
      persistPath = persistAnalysis(fname, `${toolInfo}\n\n${analysis}`);
    }

    const parts: string[] = [];
    if (toolInfo) parts.push(toolInfo);
    if (analysis) parts.push(`模型分析摘要: ${analysis.slice(0, 300)}`);
    if (persistPath) parts.push(`完整分析已保存至 ${persistPath}`);
    messages[i] = { role: 'user', content: parts.length ? parts.join(' | ') : '[已处理的媒体内容]' };
    compacted++;
  }
  return compacted;
}

/** 清理旧的文本工具结果，保留最近 keep_recent 条。修正 Python bug：role==user + tool_result blocks。 */
export function compactOldToolResults(messages: MessageParam[], keepRecent = 6): number {
  const toolIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user' && Array.isArray(m.content) && (m.content as ContentBlock[]).some(b => b.type === 'tool_result')) {
      toolIdx.push(i);
    }
  }
  if (toolIdx.length <= keepRecent) return 0;
  let compacted = 0;
  for (const idx of toolIdx.slice(0, toolIdx.length - keepRecent)) {
    const content = messages[idx].content;
    if (!Array.isArray(content)) continue;
    for (const b of content as ContentBlock[]) {
      if (b.type !== 'tool_result') continue;
      const c = String((b as { content: unknown }).content ?? '');
      if (c.length > 200 && !c.includes('[已压缩]')) {
        (b as { content: unknown }).content = c.slice(0, 150) + `... [已压缩，原始内容共${c.length}字符]`;
        compacted++;
      }
    }
  }
  return compacted;
}

/**
 * 释放较早的图片（热/冷分层的最小实现，由空响应故障触发）：
 * 把除最近 keepRecent 条含图消息之外的 image 块替换为文本占位
 * （tool_result 外壳与 tool_use_id 保留，契约不破坏；路径在 tool_use 输入里可重新 view）。
 * 返回释放的图片数。
 */
export function evictOldImages(messages: MessageParam[], keepRecent = 3): number {
  const imgMsgIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    const has = (m.content as ContentBlock[]).some(b =>
      b && typeof b === 'object' && b.type === 'tool_result' &&
      Array.isArray((b as { content?: unknown }).content) &&
      ((b as { content: Array<{ type?: string }> }).content).some(x => x && x.type === 'image'),
    );
    if (has) imgMsgIdx.push(i);
  }
  if (imgMsgIdx.length <= keepRecent) return 0;
  let evicted = 0;
  for (const idx of imgMsgIdx.slice(0, imgMsgIdx.length - keepRecent)) {
    const blocks = messages[idx].content as ContentBlock[];
    for (const b of blocks) {
      if (!b || typeof b !== 'object' || b.type !== 'tool_result') continue;
      const tr = b as { content?: Array<{ type?: string }> };
      if (!Array.isArray(tr.content)) continue;
      tr.content = tr.content.map(x => {
        if (x && x.type === 'image') {
          evicted++;
          return { type: 'text', text: '[图片已释放以缩小请求体积；需要时可重新 view 该文件]' };
        }
        return x;
      });
    }
  }
  return evicted;
}
