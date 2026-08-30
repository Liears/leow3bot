// LLM 看门狗单测（llm.ts 的 streamWithWatchdog）：流事件活跃度判活、
// 挂起转 retryable、事件到达重置计时；isImagePayloadError 判定。
import { describe, it, expect } from 'vitest';
import { streamWithWatchdog, isImagePayloadError } from '../../src/llm.js';

describe('streamWithWatchdog', () => {
  it('正常流全部透传', async () => {
    async function* src() { yield 1; yield 2; yield 3; }
    const out: number[] = [];
    for await (const v of streamWithWatchdog(src(), 1000)) out.push(v);
    expect(out).toEqual([1, 2, 3]);
  });

  it('挂起（hangMs 内无事件）→ 抛 retryable 错误', async () => {
    async function* hung() {
      yield 1;
      await new Promise(() => {}); // 永不产出
    }
    await expect(async () => {
      for await (const _v of streamWithWatchdog(hung(), 50)) { void _v; }
    }).rejects.toThrow(/挂起/);
  });

  it('错误带 retryable 标记（接入既有重试/降级链）', async () => {
    async function* hung() { await new Promise(() => {}); }
    const gen = streamWithWatchdog(hung(), 50);
    try {
      await gen.next();
      expect.unreachable();
    } catch (e) {
      expect((e as { retryable?: boolean }).retryable).toBe(true);
    }
  });

  it('事件持续到达则计时不断重置（长生成不误杀）', async () => {
    async function* slow() {
      for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 40)); // 间隔 40ms < 窗口 120ms
        yield i;
      }
    }
    const out: number[] = [];
    for await (const v of streamWithWatchdog(slow(), 120)) out.push(v);
    expect(out).toEqual([0, 1, 2, 3, 4]);
  });

  it('消费方提前 break → 底层迭代器被正确收尾', async () => {
    let finallyRan = false;
    async function* src() {
      try { yield 1; yield 2; }
      finally { finallyRan = true; }
    }
    for await (const _v of streamWithWatchdog(src(), 1000)) { void _v; break; }
    // 给 finally 微任务一点时间
    await new Promise(r => setTimeout(r, 10));
    expect(finallyRan).toBe(true);
  });
});

describe('isImagePayloadError', () => {
  it('图片类 400 识别（中文/英文/错误码三形态）', () => {
    expect(isImagePayloadError(new Error('400 {"message":"[1210][图片输入格式/解析错误]"}'))).toBe(true);
    expect(isImagePayloadError(new Error('image input format error'))).toBe(true);
    expect(isImagePayloadError(new Error('invalid image_input parse'))).toBe(true);
  });
  it('非图片错误 / 非 Error → false', () => {
    expect(isImagePayloadError(new Error('HTTP 500: internal'))).toBe(false);
    expect(isImagePayloadError(new Error('max_tokens参数非法：限制数值范围[1,131072]'))).toBe(false);
    expect(isImagePayloadError('字符串')).toBe(false);
    expect(isImagePayloadError(null)).toBe(false);
  });
});
