// LLM 流式调用：@anthropic-ai/sdk 配 Anthropic 兼容端点（baseURL + authToken + signal）
// 自己累积 content_blocks（兼容端点与 SDK currentMessage 累积不一致），组装 assistant_msg；
// yield 5 事件 + timing。SDK 仅用于 HTTP/SSE 传输 + abort。

import Anthropic from '@anthropic-ai/sdk';
import { API_BASE_URL, MODEL, MAX_TOKENS, TEMPERATURE, TOP_P, TOP_K, API_TIMEOUT, THINKING_BUDGET, getApiKey } from './config.js';
import type { MessageParam, Usage, Timing, ToolCall, StreamEvent, ContentBlock } from './types.js';

let _client: Anthropic | null = null;

export function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({
      baseURL: API_BASE_URL,
      authToken: getApiKey(),
      timeout: API_TIMEOUT * 1000,
      maxRetries: 2,
    });
  }
  return _client;
}

interface PartialBlock {
  type: string;
  text: string;
  thinking: string;
  signature: string; // thinking 块签名（部分端点返回），工具续行时透传
  id: string;
  name: string;
  input_parts: string;
}

export async function* callLLMStream(
  messages: MessageParam[],
  tools: unknown[],
  system: string,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const t0 = performance.now();
  let tFirst: number | null = null;
  let tLast: number | null = null;
  let usage: Usage | null = null;
  let stopReason: string | null = null;
  const contentBlocks = new Map<number, PartialBlock>();

  const stream = getClient().messages.stream(
    {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      ...(TOP_P != null ? { top_p: TOP_P } : {}),
      ...(TOP_K != null ? { top_k: TOP_K } : {}),
      thinking: { type: 'enabled' as const, budget_tokens: THINKING_BUDGET },
      system,
      messages: messages as never,
      tools: tools as never,
    } as never,
    { signal },
  );

  let aborted = false;
  try {
    for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
      if (signal.aborted) { aborted = true; break; }
      const type = event.type as string;

      if (type === 'message_start') {
        usage = (((event as { message?: { usage?: Usage } }).message ?? {}).usage ?? null) as Usage | null;
      } else if (type === 'content_block_start') {
        const idx = (event as { index: number }).index;
        const cb = (event as { content_block: { type: string; id?: string; name?: string; signature?: string } }).content_block;
        contentBlocks.set(idx, {
          type: cb.type, text: '', thinking: '',
          signature: cb.signature ?? '',
          id: cb.id ?? '', name: cb.name ?? '', input_parts: '',
        });
      } else if (type === 'content_block_delta') {
        const idx = (event as { index: number }).index;
        const d = (event as { delta: { type: string; thinking?: string; text?: string; partial_json?: string; reasoning_content?: string } }).delta;
        const block = contentBlocks.get(idx);
        // glm-5.2 兼容层常发空 thinking_delta（reasoning_content 转 thinking）；
        // 只对有内容的 delta 计时，否则空 delta 会污染 TTFT/TPOT。
        // 字段兜底：thinking（标准 Anthropic）?? reasoning_content（部分兼容层未转字段名）。
        const thinkChunk = d.thinking ?? d.reasoning_content;
        const hasContent =
          (d.type === 'thinking_delta' && thinkChunk) ||
          (d.type === 'text_delta' && d.text) ||
          (d.type === 'input_json_delta' && d.partial_json);
        if (hasContent) {
          const now = performance.now();
          if (tFirst === null) tFirst = now;
          tLast = now;
        }
        if (block) {
          if (d.type === 'thinking_delta' && thinkChunk) {
            block.thinking += thinkChunk;
            yield { type: 'thinking', text: thinkChunk };
          } else if (d.type === 'text_delta' && d.text) {
            block.text += d.text;
            yield { type: 'text', text: d.text };
          } else if (d.type === 'input_json_delta' && d.partial_json) {
            block.input_parts += d.partial_json;
          } else if (d.type === 'signature_delta') {
            // 官方协议 signature 走增量 delta 下发（content_block_start 里没有），
            // 兼容层则在 start 时内联——两条路径都覆盖，工具循环回传时才不缺签名
            block.signature += String((d as { signature?: string }).signature ?? '');
          }
        }
      } else if (type === 'message_delta') {
        const delta = (event as { delta: { stop_reason?: string } }).delta;
        const u = (event as { usage?: Usage }).usage;
        stopReason = delta.stop_reason ?? stopReason;
        usage = { ...(usage ?? {}), ...(u ?? {}) } as Usage;
      }
    }
  } catch (e: unknown) {
    if (signal.aborted) {
      aborted = true;
    } else if (e && typeof e === 'object' && 'status' in e) {
      const err = e as { status?: number; message?: string };
      throw new Error(`HTTP ${err.status ?? '?'}: ${err.message ?? String(e)}`);
    } else {
      throw e;
    }
  }

  // 组装 assistant content（对齐 Python _assemble_content，按 index 排序）
  const assistantContent: ContentBlock[] = [];
  const toolCalls: ToolCall[] = [];
  for (const idx of [...contentBlocks.keys()].sort((a, b) => a - b)) {
    const b = contentBlocks.get(idx)!;
    if (b.type === 'thinking' && b.thinking) {
      assistantContent.push({ type: 'thinking', thinking: b.thinking, ...(b.signature ? { signature: b.signature } : {}) });
    } else if (b.type === 'text' && b.text) {
      assistantContent.push({ type: 'text', text: b.text });
    } else if (b.type === 'tool_use') {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(b.input_parts) as Record<string, unknown>; } catch { input = {}; }
      assistantContent.push({ type: 'tool_use', id: b.id, name: b.name, input });
      toolCalls.push({ id: b.id, name: b.name, input });
    }
  }

  const assistantMsg: MessageParam = { role: 'assistant', content: assistantContent };
  const tEnd = performance.now();
  const timing: Timing = {
    ttft: tFirst !== null ? tFirst - t0 : null,
    decode_time: tFirst !== null && tLast !== null ? tLast - tFirst : null,
    total: tEnd - t0,
  };

  if (aborted || signal.aborted) {
    yield { type: 'interrupted', assistant_msg: assistantMsg, usage, timing };
  } else if (stopReason === 'tool_use' && toolCalls.length) {
    yield { type: 'tool_call', assistant_msg: assistantMsg, tool_calls: toolCalls, usage, timing };
  } else {
    // 退化完成检测：流正常结束但零内容块（stop_reason 还可能是 end_turn）——
    // 实测 vLLM 对多图大 payload 会这样静默返回空。不能当正常 done（会表现为
    // "突然停止、无报错无回复"），抛可重试错误让上层处理。
    if (assistantContent.length === 0 && toolCalls.length === 0) {
      const err = new Error(
        `模型返回空响应（无内容块，stop_reason=${stopReason ?? '无'}）。` +
        '可能是服务端过载或单请求图片过多/体积过大——可减少单批 view 的图片数量后重试',
      ) as Error & { retryable?: boolean };
      err.retryable = true;
      throw err;
    }
    yield { type: 'done', assistant_msg: assistantMsg, usage, timing };
  }
}

// countTokens（beta，/v1/messages/count_tokens）：用模型 tokenizer 精确计数，供 /context 明细用。
// 端点若不支持该 beta 会抛错，catch 返回 null。
export async function countTokens(system: string, messages: MessageParam[], tools: unknown[]): Promise<number | null> {
  try {
    const r = await getClient().beta.messages.countTokens({
      model: MODEL, system, messages: messages as never, tools: tools as never,
    } as never);
    return (r as { input_tokens: number }).input_tokens;
  } catch {
    return null;
  }
}
