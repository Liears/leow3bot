// LLM 流组装集成测试（llm.ts 的 callLLMStream/llmStreamOnce）：mock @anthropic-ai/sdk，
// 用合成 SSE 事件序列驱动完整解析路径——thinking/text/tool_use 组装、signature 两条
// 下发路径、glm reasoning_content 兼容、usage 合并、空响应检测、max_tokens 错误驱动
// 自适应、HTTP 错误包装、中断。LEOW3BOT_HOME 隔离 setModelMaxTokens 写盘。
import { vi, describe, it, expect, beforeEach, afterAll } from 'vitest';

vi.hoisted(() => {
  process.env.LEOW3BOT_HOME = `/tmp/leow3bot-llm-test-${process.pid}`;
});

const sdk = vi.hoisted(() => ({
  // 可变实现：每个测试注入自己的流行为（参数与请求 opts 都捕获）
  calls: [] as Array<{ params: Record<string, unknown>; opts: Record<string, unknown> }>,
  streamImpl: (_p: unknown, _opts?: unknown): AsyncIterable<Record<string, unknown>> => { throw new Error('未设置 streamImpl'); },
  countTokensImpl: async () => ({ input_tokens: 0 }),
  modelsImpl: async () => ({ data: [] }),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic {
    messages = {
      stream: (params: Record<string, unknown>, opts: Record<string, unknown>) => {
        sdk.calls.push({ params, opts });
        return sdk.streamImpl(params);
      },
    };
    beta = { messages: { countTokens: () => sdk.countTokensImpl() } };
    models = { list: () => sdk.modelsImpl() };
  },
}));

import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { callLLMStream, countTokens } from '../../src/llm.js';

const HOME = process.env.LEOW3BOT_HOME!;
const MODEL_ID = 'llm-test-model';

beforeEach(() => {
  sdk.calls.length = 0;
  mkdirSync(path.join(HOME, '.leow3bot'), { recursive: true });
});
afterAll(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* noop */ } });

/** 把一次"LLM 回复"编成 SSE 事件序列（message_start → blocks → message_delta/stop） */
function scriptResponse(blocks: Array<Array<Record<string, unknown>>>, stopReason: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [{ type: 'message_start', message: { usage: { input_tokens: 11 } } }];
  blocks.forEach((deltas, i) => {
    const start = deltas[0] as { block?: Record<string, unknown> };
    if (start.block) events.push({ type: 'content_block_start', index: i, content_block: start.block });
    for (const d of deltas) if (d.delta) events.push({ type: 'content_block_delta', index: i, delta: d.delta });
    events.push({ type: 'content_block_stop', index: i });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 7 } });
  events.push({ type: 'message_stop' });
  return events;
}

async function* eventsOf(events: Record<string, unknown>[]): AsyncIterable<Record<string, unknown>> {
  yield* events;
}

const collect = async (args: Parameters<typeof callLLMStream>) => {
  const out: Array<{ type: string; [k: string]: unknown }> = [];
  for await (const ev of callLLMStream(...args)) out.push(ev as { type: string });
  return out;
};

describe('callLLMStream 流组装', () => {
  it('纯文本回复：text 事件流 + done + 组装 assistant 消息 + usage/timing', async () => {
    sdk.streamImpl = () => eventsOf(scriptResponse([
      [{ block: { type: 'text' } }, { delta: { type: 'text_delta', text: '你好' } }, { delta: { type: 'text_delta', text: '，世界' } }],
    ], 'end_turn'));

    const events = await collect([[], [], 'sys', new AbortController().signal, MODEL_ID]);
    expect(events.filter(e => e.type === 'text').map(e => e.text).join('')).toBe('你好，世界');
    const done = events.find(e => e.type === 'done')!;
    expect((done.assistant_msg as { content: Array<{ type: string; text: string }> }).content)
      .toEqual([{ type: 'text', text: '你好，世界' }]);
    // usage 合并：message_start 的 input + message_delta 的 output
    expect((done.usage as { input_tokens: number; output_tokens: number })).toMatchObject({ input_tokens: 11, output_tokens: 7 });
    expect((done.timing as { ttft: number | null }).ttft).not.toBeNull();
    // 请求参数形态
    expect(sdk.calls[0].params.model).toBe(MODEL_ID);
    expect(sdk.calls[0].params.thinking).toEqual({ type: 'enabled', budget_tokens: expect.any(Number) });
  });

  it('thinking 块 + signature 增量下发（官方协议路径）→ 组装含签名', async () => {
    sdk.streamImpl = () => eventsOf(scriptResponse([
      [
        { block: { type: 'thinking' } },
        { delta: { type: 'thinking_delta', thinking: '深度思考' } },
        { delta: { type: 'signature_delta', signature: 'sig-abc' } },
      ],
      [{ block: { type: 'text' } }, { delta: { type: 'text_delta', text: '结论' } }],
    ], 'end_turn'));

    const events = await collect([[], [], 'sys', new AbortController().signal, MODEL_ID]);
    expect(events.filter(e => e.type === 'thinking').map(e => e.text).join('')).toBe('深度思考');
    const done = events.find(e => e.type === 'done')!;
    const content = (done.assistant_msg as { content: Array<{ type: string }> }).content;
    expect(content[0]).toMatchObject({ type: 'thinking', thinking: '深度思考', signature: 'sig-abc' });
    expect(content[1]).toEqual({ type: 'text', text: '结论' });
  });

  it('thinking signature 在 content_block_start 内联（兼容层路径）也能收到', async () => {
    sdk.streamImpl = () => eventsOf(scriptResponse([
      [
        { block: { type: 'thinking', signature: 'inline-sig' } },
        { delta: { type: 'thinking_delta', thinking: '想' } },
      ],
    ], 'end_turn'));

    const events = await collect([[], [], 'sys', new AbortController().signal, MODEL_ID]);
    const done = events.find(e => e.type === 'done')!;
    const content = (done.assistant_msg as { content: Array<{ type: string; signature?: string }> }).content;
    expect(content[0].signature).toBe('inline-sig');
  });

  it('glm 兼容：reasoning_content 字段兜底为 thinking', async () => {
    sdk.streamImpl = () => eventsOf(scriptResponse([
      [
        { block: { type: 'thinking' } },
        { delta: { type: 'thinking_delta', reasoning_content: '兼容层思考' } },
      ],
      [{ block: { type: 'text' } }, { delta: { type: 'text_delta', text: '答' } }],
    ], 'end_turn'));

    const events = await collect([[], [], 'sys', new AbortController().signal, MODEL_ID]);
    expect(events.some(e => e.type === 'thinking' && e.text === '兼容层思考')).toBe(true);
  });

  it('工具调用：input_json_delta 组装 + tool_call 事件 + 停在 tool_use', async () => {
    sdk.streamImpl = () => eventsOf(scriptResponse([
      [{ block: { type: 'text' } }, { delta: { type: 'text_delta', text: '我先查一下' } }],
      [
        { block: { type: 'tool_use', id: 'toolu_9', name: 'bash' } },
        { delta: { type: 'input_json_delta', partial_json: '{"command":"echo' } },
        { delta: { type: 'input_json_delta', partial_json: ' hi"}' } },
      ],
    ], 'tool_use'));

    const events = await collect([[], [], 'sys', new AbortController().signal, MODEL_ID]);
    const tc = events.find(e => e.type === 'tool_call')!;
    expect((tc.tool_calls as Array<{ id: string; name: string; input: unknown }>)[0]).toEqual({
      id: 'toolu_9', name: 'bash', input: { command: 'echo hi' },
    });
    const content = (tc.assistant_msg as { content: Array<{ type: string }> }).content;
    expect(content.map(b => b.type)).toEqual(['text', 'tool_use']);
    expect(events.some(e => e.type === 'done')).toBe(false);
  });

  it('坏 JSON 的工具入参 → 降级为空对象（不崩）', async () => {
    sdk.streamImpl = () => eventsOf(scriptResponse([
      [
        { block: { type: 'tool_use', id: 't1', name: 'read' } },
        { delta: { type: 'input_json_delta', partial_json: '{broken' } },
      ],
    ], 'tool_use'));
    const events = await collect([[], [], 'sys', new AbortController().signal, MODEL_ID]);
    const tc = events.find(e => e.type === 'tool_call')!;
    expect((tc.tool_calls as Array<{ input: unknown }>)[0].input).toEqual({});
  });

  it('空响应（流结束零内容块）→ 抛 retryable（上层接入重试/降级链）', async () => {
    sdk.streamImpl = () => eventsOf([
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } },
      { type: 'message_stop' },
    ]);
    await expect(collect([[], [], 'sys', new AbortController().signal, MODEL_ID]))
      .rejects.toThrow(/空响应/);
  });

  it('HTTP 状态错误 → 包装为 "HTTP <status>: ..." Error', async () => {
    sdk.streamImpl = async function* () {
      yield { type: 'message_start', message: { usage: {} } };
      throw Object.assign(new Error('Internal server error'), { status: 500 });
    };
    await expect(collect([[], [], 'sys', new AbortController().signal, MODEL_ID]))
      .rejects.toThrow('HTTP 500');
  });

  it('max_tokens 超限 400 → 提取上限静默学习并重试一次成功', async () => {
    let attempt = 0;
    sdk.streamImpl = (_p) => {
      attempt++;
      if (attempt === 1) {
        return (async function* () {
          throw new Error('400 {"message":"max_tokens参数非法：限制数值范围[1,131072]"}');
        })();
      }
      return eventsOf(scriptResponse([
        [{ block: { type: 'text' } }, { delta: { type: 'text_delta', text: '自适应成功' } }],
      ], 'end_turn'));
    };

    const events = await collect([[], [], 'sys', new AbortController().signal, MODEL_ID]);
    expect(attempt).toBe(2); // 首撞 + 自适应重试
    expect(sdk.calls[1].params.max_tokens).toBe(131072); // 第二次带学到的上限
    expect(events.find(e => e.type === 'done')).toBeDefined();
    // 学到的上限持久化（下次启动不复撞）
    const { getModelMaxTokens } = await import('../../src/config.js');
    expect(getModelMaxTokens(MODEL_ID)).toBe(131072);
  });

  it('abort 中断 → interrupted 事件（已组装的部分内容随行）', async () => {
    const ctrl = new AbortController();
    sdk.streamImpl = (_p, opts) => (async function* () {
      yield { type: 'message_start', message: { usage: { input_tokens: 3 } } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '写到一半' } };
      // 模拟 SDK：signal 中止后迭代抛错
      await new Promise(r => setTimeout(r, 50));
      if ((opts as { signal: AbortSignal }).signal.aborted) throw new Error('Request was aborted.');
    })();

    setTimeout(() => ctrl.abort(), 10);
    const events = await collect([[], [], 'sys', ctrl.signal, MODEL_ID]);
    const interrupted = events.find(e => e.type === 'interrupted');
    expect(interrupted).toBeDefined();
    const content = (interrupted!.assistant_msg as { content: Array<{ type: string; text: string }> }).content;
    expect(content).toEqual([{ type: 'text', text: '写到一半' }]);
  });
});

describe('countTokens', () => {
  it('正常返回 input_tokens', async () => {
    sdk.countTokensImpl = async () => ({ input_tokens: 4321 });
    expect(await countTokens('sys', [], [])).toBe(4321);
  });

  it('端点不支持 → null（不抛）', async () => {
    sdk.countTokensImpl = async () => { throw new Error('not found'); };
    expect(await countTokens('sys', [], [])).toBeNull();
  });
});
