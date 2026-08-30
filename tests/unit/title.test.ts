// title.ts 后台主题生成测试：首次触发条件 / 主题清洗（去引号 + 截 40）/
// 「新增 3 条 user 消息」节流 / initTitleState 基准（resume 不立即重生成）/
// 失败静默可重试。mock getClient 的 messages.create；LEOW3BOT_HOME 隔离 autosave。
import { vi, describe, it, expect, beforeEach, afterAll } from 'vitest';

vi.hoisted(() => {
  process.env.LEOW3BOT_HOME = `/tmp/leow3bot-title-test-${process.pid}`;
});

const sdk = vi.hoisted(() => ({
  createImpl: async (_p?: unknown) => ({ content: [] as Array<{ type: string; text?: string }> }),
  calls: 0,
}));

vi.mock('../../src/llm.js', () => ({
  getClient: () => ({
    messages: { create: (...args: unknown[]) => { sdk.calls++; return sdk.createImpl(args[0]); } },
  }),
  countTokens: vi.fn(async () => null),
}));

import { mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { maybeUpdateTitle, initTitleState } from '../../src/title.js';
import { getSessionTitle, setSessionTitle } from '../../src/session.js';
import type { MessageParam } from '../../src/types.js';

const HOME = process.env.LEOW3BOT_HOME!;
const SESSION_DIR = path.join(HOME, '.leow3bot', 'sessions');

const replyWith = (text: string) => { sdk.createImpl = async () => ({ content: [{ type: 'text', text }] }); };
const users = (n: number): MessageParam[] => Array.from({ length: n }, (_, i) => ({ role: 'user', content: `消息${i + 1}` }));

beforeEach(() => {
  mkdirSync(SESSION_DIR, { recursive: true });
  sdk.calls = 0;
  replyWith('「E2E 测试主题」');
  setSessionTitle(''); // 归一 null，从无主题起步
  initTitleState([]);
});
afterAll(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* noop */ } });

/** 轮询等 fire-and-forget 的后台生成完成（主题已写入或 create 计数到位） */
const waitCalls = async (n: number) => {
  await vi.waitFor(() => { expect(sdk.calls).toBe(n); }, { timeout: 3000 });
};

describe('maybeUpdateTitle', () => {
  it('无主题时 1 条 user 消息即触发；主题清洗（去「」引号）并写入 autosave', async () => {
    maybeUpdateTitle(users(1));
    await waitCalls(1);
    expect(getSessionTitle()).toBe('E2E 测试主题');
    // autosave 立即用新主题重写
    await vi.waitFor(() => {
      const files = readdirSync(SESSION_DIR).filter(f => f.startsWith('current_'));
      expect(files.length).toBeGreaterThan(0);
      expect(JSON.parse(readFileSync(path.join(SESSION_DIR, files[0]), 'utf-8')).name).toBe('E2E 测试主题');
    });
  });

  it('超长主题截到 40 字符', async () => {
    replyWith('很长'.repeat(30)); // 60 字
    maybeUpdateTitle(users(1));
    await waitCalls(1);
    expect(getSessionTitle()).toHaveLength(40);
  });

  it('节流：有主题后 +1 不触发，+3 触发刷新', async () => {
    maybeUpdateTitle(users(1));
    await waitCalls(1);
    expect(getSessionTitle()).toBe('E2E 测试主题');

    maybeUpdateTitle(users(2)); // 2-1=1 < 3
    await new Promise(r => setTimeout(r, 100));
    expect(sdk.calls).toBe(1);

    replyWith('刷新后的主题');
    maybeUpdateTitle(users(4)); // 4-1=3 ≥ 3 → 触发
    await waitCalls(2);
    expect(getSessionTitle()).toBe('刷新后的主题');
  });

  it('空回复（无 text 块）不设置主题', async () => {
    sdk.createImpl = async () => ({ content: [] });
    maybeUpdateTitle(users(1));
    await waitCalls(1);
    await new Promise(r => setTimeout(r, 50));
    expect(getSessionTitle()).toBeNull();
  });

  it('端点失败静默：主题不变、计数不推进；恢复后重试成功', async () => {
    sdk.createImpl = async () => { throw new Error('HTTP 500'); };
    maybeUpdateTitle(users(1));
    await waitCalls(1);
    await new Promise(r => setTimeout(r, 50));
    expect(getSessionTitle()).toBeNull();

    replyWith('恢复后的主题');
    maybeUpdateTitle(users(1)); // lastTrigger 未推进 → 仍满足触发条件
    await waitCalls(2);
    expect(getSessionTitle()).toBe('恢复后的主题');
  });

  it('initTitleState 基准：resume 后同量消息不触发（避免首轮立即重生成）', async () => {
    setSessionTitle('已有主题');
    initTitleState(users(5)); // resume 场景：基准 = 当前 user 数
    maybeUpdateTitle(users(5)); // 5-5=0 < 3
    await new Promise(r => setTimeout(r, 100));
    expect(sdk.calls).toBe(0);
    expect(getSessionTitle()).toBe('已有主题');
  });

  it('空消息数组直接返回', () => {
    maybeUpdateTitle([]);
    expect(sdk.calls).toBe(0);
  });
});
