// 工具调度：分批、并发/串行执行、结果处理（移植 executor.py）
// registry 参数：主对话缺省 TOOLS_REGISTRY；子代理传白名单过滤后的注册表
// （弱模型可能幻觉白名单外的工具名，按过滤表查即拦截为「未知工具」）。

import { TOOLS_REGISTRY, type ToolDef } from './tools.js';
import { MAX_TOOL_RESULT_CHARS, WEB_RESULT_MAX_CHARS } from './config.js';
import { truncateMiddle } from './lib/format.js';
import { checkPermission, confirmAction, getPermissionTarget } from './permissions.js';
import { toolRunningStart, toolRunningEnd } from './store.js';
import type { ToolCall, ToolResultBlock, MessageParam } from './types.js';

/** 工具入参摘要（状态面板/打点行用）：取最能代表调用的一个字符串参数，截断 */
export function summarizeToolInput(call: { name: string; input: Record<string, unknown> }): string {
  const prefer = ['command', 'path', 'query', 'url', 'prompt', 'name', 'question'];
  for (const k of prefer) {
    const v = call.input?.[k];
    if (typeof v === 'string' && v.trim()) {
      const t = v.replace(/\s+/g, ' ').trim();
      return t.length > 60 ? t.slice(0, 57) + '…' : t;
    }
  }
  return '';
}

// 工具打点自增序号
let toolSeq = 0;

export interface ToolBatch { safe: boolean; calls: ToolCall[] }

export function partitionToolCalls(toolCalls: ToolCall[], registry: Record<string, ToolDef> = TOOLS_REGISTRY): ToolBatch[] {
  const batches: ToolBatch[] = [];
  for (const tc of toolCalls) {
    const safe = registry[tc.name]?.concurrencySafe ?? false;
    const last = batches[batches.length - 1];
    if (last && last.safe && safe) last.calls.push(tc);
    else batches.push({ safe, calls: [tc] });
  }
  return batches;
}

/**
 * interactive=false 为子代理语境（runner 传入）：① confirm 规则自动拒绝——
 * 子代理不能向用户提问，并行语境争抢唯一 askResolver（设计文档 §5.8）；
 * ② 不登记通用打点行——子代理面板的专属行（activity）已覆盖其内部工具。
 */
export async function executeTool(name: string, args: Record<string, unknown>, registry: Record<string, ToolDef> = TOOLS_REGISTRY, interactive = true): Promise<unknown> {
  const def = registry[name];
  if (!def) return { type: 'error', message: `未知工具: ${name}` };
  // 权限管控：deny 直接拒绝；confirm 弹交互确认（用户拒绝也拒绝执行）
  const target = getPermissionTarget(name, args);
  if (target !== null) {
    const d = checkPermission(name, target);
    if (d.verdict === 'deny') {
      return { type: 'error', message: `⛔ 操作被权限管控拒绝（规则 ${d.ruleId}）：${d.reason}。请改用更安全的方式，或先向用户说明你的意图。` };
    }
    if (d.verdict === 'confirm') {
      if (!interactive) {
        return { type: 'error', message: '操作命中用户确认规则，但子代理无法交互确认——请在主对话中直接执行该操作以触发确认' };
      }
      const ok = await confirmAction(name, target, d.reason ?? '命中用户配置的确认规则');
      if (!ok) return { type: 'error', message: `操作被用户拒绝（权限确认），请换一种方式或先询问用户。` };
    }
  }
  // 运行打点：主对话的工具登记面板行（subagent 工具有专属行，跳过防重复）
  const track = interactive && name !== 'subagent';
  const key = track ? ++toolSeq : 0;
  if (track) toolRunningStart({ key, name, summary: summarizeToolInput({ name, input: args }), startedAt: Date.now() });
  try {
    return await def.function(args);
  } catch (e) {
    return { type: 'error', message: `工具执行错误: ${(e as Error).message}` };
  } finally {
    if (track) toolRunningEnd(key);
  }
}

export async function executeBatch(batch: ToolBatch, registry: Record<string, ToolDef> = TOOLS_REGISTRY, interactive = true): Promise<Array<[ToolCall, unknown]>> {
  const calls = batch.calls;
  if (batch.safe && calls.length > 1) {
    const results = await Promise.all(
      calls.map(async tc => [tc, await executeTool(tc.name, tc.input, registry, interactive)] as [ToolCall, unknown]),
    );
    return results; // Promise.all 保序
  }
  const out: Array<[ToolCall, unknown]> = [];
  for (const tc of calls) out.push([tc, await executeTool(tc.name, tc.input, registry, interactive)]);
  return out;
}

export function buildToolResultBlock(tc: ToolCall, result: unknown): ToolResultBlock {
  const toolUseId = tc.id;
  const r = result as { type?: string; output?: string; path?: string; size?: string; media_type?: string; base64?: string; message?: string; content?: string };

  if (r && r.type === 'bash') {
    return { type: 'tool_result', tool_use_id: toolUseId, content: r.output ?? '(无输出)' };
  }
  if (r && r.type === 'image') {
    // 文件名双侧夹注（开闭标签式）：批量看图时"像素↔文件名"的绑定只靠
    // 位置相邻（单侧锚点），注意力渗漏会把内容绑到相邻图上（实测事故：
    // 内容真、归属错）。前后各念一遍文件名 = 任意位置的注意力到锚点的
    // 距离减半 + 明确边界标记，结构化标记是模型训练最深的绑定语法。
    const name = r.path ? String(r.path).split('/').pop() : '未知图片';
    return {
      type: 'tool_result', tool_use_id: toolUseId,
      content: [
        { type: 'text', text: `<img name="${name}">\n${r.path} (${r.size})` },
        { type: 'image', source: { type: 'base64', media_type: r.media_type ?? 'image/png', data: r.base64 ?? '' } },
        { type: 'text', text: `</img name="${name}">` },
      ],
    };
  }
  if (r && r.type === 'error') {
    return { type: 'tool_result', tool_use_id: toolUseId, content: r.message ?? '未知错误', is_error: true };
  }
  if (r && r.type === 'text') {
    let content = r.content ?? '';
    if (content.length > MAX_TOOL_RESULT_CHARS) {
      content = truncateMiddle(content, MAX_TOOL_RESULT_CHARS) + `\n[完整内容共 ${r.content?.length ?? 0} 字符]`;
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
  if (r && r.type === 'task') {
    // 子代理结果：report 是回传正文（已按上限截断/落盘），output 仅供 UI ⎿ 摘要
    const t = result as { report?: string };
    return { type: 'tool_result', tool_use_id: toolUseId, content: t.report ?? '(无输出)' };
  }
  let raw = String(result);
  if (raw.length > MAX_TOOL_RESULT_CHARS) raw = truncateMiddle(raw, MAX_TOOL_RESULT_CHARS);
  return { type: 'tool_result', tool_use_id: toolUseId, content: raw };
}

export function flushToolResults(blocks: ToolResultBlock[], messages: MessageParam[]): void {
  if (!blocks.length) return;
  messages.push({ role: 'user', content: blocks });
}
