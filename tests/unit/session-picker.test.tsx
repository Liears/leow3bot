// SessionPicker 交互测试：列表渲染/↓+Enter 恢复（消息注入 + committed 重建 + 回
// idle）/损坏会话反馈/Esc 新会话/空态。mock llm 的 countTokens（activateResume 会
// 后台调它补上下文占用，不能走真网络）。按键注入两坑见 model-picker 注。
process.env.FORCE_COLOR = '1';

import { vi, describe, it, expect, beforeEach, afterAll } from 'vitest';

vi.hoisted(() => {
  process.env.LEOW3BOT_HOME = `/tmp/leow3bot-sessp-test-${process.pid}`;
});

vi.mock('../../src/llm.js', () => ({
  countTokens: vi.fn(async () => null), // refreshUsageAfterResume 走字符估算分支
  getClient: vi.fn(),
}));

import { rmSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import stripAnsi from 'strip-ansi';
import { render } from 'ink-testing-library';
import SessionPicker from '../../src/components/SessionPicker.js';
import { saveSession } from '../../src/session.js';
import { getMessages, clearMessages } from '../../src/agent.js';
import { getState, setPhase } from '../../src/store.js';

const HOME = process.env.LEOW3BOT_HOME!;
const SESSION_DIR = path.join(HOME, '.leow3bot', 'sessions');

const press = (stdin: { write: (s: string) => void }, s: string): void => {
  stdin.write(s);
  stdin.write('');
};
const settle = () => new Promise(r => setTimeout(r, 50));
const DOWN = '\u001B[B';
const ENTER = '\r';
const ESC = '\u001B';
const norm = (s: string) => stripAnsi(s).replace(/\s+/g, ' ');

beforeEach(() => {
  mkdirSync(SESSION_DIR, { recursive: true });
  clearMessages();
  const committed = getState().committed;
  committed.splice(0, committed.length);
  setPhase('session_picker');
});
afterAll(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* noop */ } });

describe('SessionPicker', () => {
  it('列表渲染会话（文件名 + 主题 + 条数）', async () => {
    saveSession([
      { role: 'user', content: '第一个会话的内容' },
      { role: 'assistant', content: [{ type: 'text', text: '回复' }] },
    ], '主题甲');
    const { lastFrame, unmount } = render(<SessionPicker />);
    await settle();
    const f = norm(lastFrame() ?? '');
    expect(f).toContain('恢复会话');
    expect(f).toContain('主题甲');
    expect(f).toContain('2 条');
    unmount();
    await settle();
  });

  it('↓ + Enter 恢复：消息注入 + committed 重建 + 回 idle', async () => {
    saveSession([{ role: 'user', content: '要恢复的消息' }], '主题乙');
    const { lastFrame, stdin, unmount } = render(<SessionPicker />);
    await settle();
    // 列表只有刚保存的这一个会话，光标默认在其上（行首 ▶，显示文件名 + 主题）
    await vi.waitFor(() => { expect(norm(lastFrame() ?? '')).toContain('▶ '); });
    expect(norm(lastFrame() ?? '')).toContain('主题乙 (1 条)');
    press(stdin, ENTER);
    await vi.waitFor(() => { expect(getState().phase).toBe('idle'); });
    expect(getMessages()).toHaveLength(1); // activateResume 注入
    expect(getMessages()[0].content).toBe('要恢复的消息');
    const sys = getState().committed.find(i => i.kind === 'system') as { text?: string };
    expect(sys?.text).toContain('✓ 已恢复会话');
    // 历史重建进 committed（rebuildCommitted）
    expect(getState().committed.some(i => i.kind === 'user')).toBe(true);
    unmount();
    await settle();
  });

  it('损坏会话（messages 非数组）→ 明确失败反馈，不静默开新会话', async () => {
    // 会话目录只留这一个损坏文件（避免依赖列表顺序）
    for (const f of readdirSync(SESSION_DIR)) unlinkSync(path.join(SESSION_DIR, f));
    writeFileSync(path.join(SESSION_DIR, 'broken.json'), JSON.stringify({ name: '坏会话', messages: 'not-array', projectRoot: '', timestamp: '2026-08-30_00-00-00', message_count: 1 }));
    const { lastFrame, stdin, unmount } = render(<SessionPicker />);
    await settle();
    press(stdin, ENTER); // 光标在唯一项上
    await vi.waitFor(() => { expect(getState().phase).toBe('idle'); });
    const sys = getState().committed.find(i => i.kind === 'system') as { text?: string; tone?: string };
    expect(sys?.text).toContain('✗ 恢复会话失败');
    expect(getMessages()).toHaveLength(0);
    unmount();
    await settle();
  });

  it('Esc → 新会话（不恢复）', async () => {
    const { lastFrame, stdin, unmount } = render(<SessionPicker />);
    await settle();
    press(stdin, ESC);
    await vi.waitFor(() => { expect(getState().phase).toBe('idle'); });
    expect(getMessages()).toHaveLength(0);
    unmount();
    await settle();
  });

  it('无会话 → 空态提示', async () => {
    for (const f of readdirSync(SESSION_DIR)) unlinkSync(path.join(SESSION_DIR, f));
    const { lastFrame, unmount } = render(<SessionPicker />);
    await settle();
    expect(norm(lastFrame() ?? '')).toContain('没有已保存的会话');
    unmount();
    await settle();
  });
});
