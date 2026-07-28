// 工具调度：分批、并发/串行执行、结果处理（移植 executor.py）

import { TOOLS_REGISTRY } from './tools.js';
import { MAX_TOOL_RESULT_CHARS, WEB_RESULT_MAX_CHARS } from './config.js';
import type { ToolCall, ToolResultBlock, MessageParam } from './types.js';

export interface ToolBatch { safe: boolean; calls: ToolCall[] }

export function partitionToolCalls(toolCalls: ToolCall[]): ToolBatch[] {
  const batches: ToolBatch[] = [];
  for (const tc of toolCalls) {
    const safe = TOOLS_REGISTRY[tc.name]?.concurrencySafe ?? false;
    const last = batches[batches.length - 1];
    if (last && last.safe && safe) last.calls.push(tc);
    else batches.push({ safe, calls: [tc] });
  }
  return batches;
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const def = TOOLS_REGISTRY[name];
  if (!def) return { type: 'error', message: `未知工具: ${name}` };
  try {
    return await def.function(args);
  } catch (e) {
    return { type: 'error', message: `工具执行错误: ${(e as Error).message}` };
  }
}

export async function executeBatch(batch: ToolBatch): Promise<Array<[ToolCall, unknown]>> {
  const calls = batch.calls;
  if (batch.safe && calls.length > 1) {
    const results = await Promise.all(
      calls.map(async tc => [tc, await executeTool(tc.name, tc.input)] as [ToolCall, unknown]),
    );
    return results; // Promise.all 保序
  }
  const out: Array<[ToolCall, unknown]> = [];
  for (const tc of calls) out.push([tc, await executeTool(tc.name, tc.input)]);
  return out;
}

export function buildToolResultBlock(tc: ToolCall, result: unknown): ToolResultBlock {
  const toolUseId = tc.id;
  const r = result as { type?: string; output?: string; path?: string; size?: string; media_type?: string; base64?: string; message?: string; content?: string };

  if (r && r.type === 'bash') {
    return { type: 'tool_result', tool_use_id: toolUseId, content: r.output ?? '(无输出)' };
  }
  if (r && r.type === 'image') {
    return {
      type: 'tool_result', tool_use_id: toolUseId,
      content: [
        { type: 'text', text: `已加载图片: ${r.path} (${r.size})` },
        { type: 'image', source: { type: 'base64', media_type: r.media_type ?? 'image/png', data: r.base64 ?? '' } },
      ],
    };
  }
  if (r && r.type === 'error') {
    return { type: 'tool_result', tool_use_id: toolUseId, content: r.message ?? '未知错误', is_error: true };
  }
  if (r && r.type === 'text') {
    let content = r.content ?? '';
    if (content.length > MAX_TOOL_RESULT_CHARS) {
      content = content.slice(0, MAX_TOOL_RESULT_CHARS) + `\n\n[文件内容过大，已截断。完整内容共 ${r.content?.length ?? 0} 字符]`;
    }
    return { type: 'tool_result', tool_use_id: toolUseId, content };
  }
  if (r && r.type === 'web_search') {
    const ws = result as {
      output?: string; query?: string; engine?: string;
      results?: Array<{ title?: string; link?: string; content?: string; media?: string; publish_date?: string }>;
    };
    const hits = ws.results ?? [];
    if (!hits.length) {
      return { type: 'tool_result', tool_use_id: toolUseId, content: ws.output ?? '搜索无结果' };
    }
    let text = `🔍 网络搜索结果（query: "${ws.query ?? ''}"，引擎: ${ws.engine ?? ''}，${hits.length} 条）\n\n`;
    hits.forEach((hit, i) => {
      text += `[${i + 1}] ${hit.title || '(无标题)'}\n`;
      if (hit.link) text += `    链接: ${hit.link}\n`;
      if (hit.media) text += `    来源: ${hit.media}\n`;
      if (hit.publish_date) text += `    发布: ${hit.publish_date}\n`;
      if (hit.content) text += `    摘要: ${hit.content}\n`;
      text += '\n';
    });
    text += '\n⚠️ 请在回答中用 markdown 链接引用上述来源（[标题](链接)）。';
    if (text.length > WEB_RESULT_MAX_CHARS) text = text.slice(0, WEB_RESULT_MAX_CHARS) + '\n\n[结果过长，已截断]';
    return { type: 'tool_result', tool_use_id: toolUseId, content: text };
  }
  if (r && r.type === 'web_fetch') {
    // 只取回原始内容：content 即网页 markdown 全文，不做任何包装/摘要
    const wf = result as { content?: string; output?: string };
    return { type: 'tool_result', tool_use_id: toolUseId, content: wf.content ?? wf.output ?? '读取失败' };
  }
  let raw = String(result);
  if (raw.length > MAX_TOOL_RESULT_CHARS) raw = raw.slice(0, MAX_TOOL_RESULT_CHARS) + '\n\n[输出已截断]';
  return { type: 'tool_result', tool_use_id: toolUseId, content: raw };
}

export function flushToolResults(blocks: ToolResultBlock[], messages: MessageParam[]): void {
  if (!blocks.length) return;
  messages.push({ role: 'user', content: blocks });
}
