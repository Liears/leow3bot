// LLM 流式调用：@anthropic-ai/sdk 配 dashscope（baseURL + authToken + signal）
// 对齐 Python llm.py：自己累积 content_blocks（dashscope 与 SDK currentMessage 累积不兼容），
// 组装 assistant_msg；yield 5 事件 + timing。SDK 仅用于 HTTP/SSE 传输 + abort。

import Anthropic from '@anthropic-ai/sdk';
import { API_BASE_URL, MODEL, MAX_TOKENS, TEMPERATURE, TOP_P, TOP_K, API_TIMEOUT, getApiKey } from './config.js';
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
        const cb = (event as { content_block: { type: string; id?: string; name?: string } }).content_block;
        contentBlocks.set(idx, {
          type: cb.type, text: '', thinking: '',
          id: cb.id ?? '', name: cb.name ?? '', input_parts: '',
        });
      } else if (type === 'content_block_delta') {
        const idx = (event as { index: number }).index;
        const d = (event as { delta: { type: string; thinking?: string; text?: string; partial_json?: string } }).delta;
        const block = contentBlocks.get(idx);
        if (d.type === 'thinking_delta' || d.type === 'text_delta' || d.type === 'input_json_delta') {
          const now = performance.now();
          if (tFirst === null) tFirst = now;
          tLast = now;
        }
        if (block) {
          if (d.type === 'thinking_delta' && d.thinking) {
            block.thinking += d.thinking;
            yield { type: 'thinking', text: d.thinking };
          } else if (d.type === 'text_delta' && d.text) {
            block.text += d.text;
            yield { type: 'text', text: d.text };
          } else if (d.type === 'input_json_delta' && d.partial_json) {
            block.input_parts += d.partial_json;
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
      assistantContent.push({ type: 'thinking', thinking: b.thinking });
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
    yield { type: 'done', assistant_msg: assistantMsg, usage, timing };
  }
}

// countTokens（beta，/v1/messages/count_tokens）：用模型 tokenizer 精确计数，供 /context 明细用。
// dashscope 若不支持该 beta 端点会抛错，catch 返回 null。
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
