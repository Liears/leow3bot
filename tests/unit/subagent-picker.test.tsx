// SubagentPicker 交互测试：首项「跟随主模型」语义、↓+Enter 持久化 subagentModel、
// 恢复跟随（null）、Esc 取消。mock getClient；LEOW3BOT_HOME 隔离写盘。
process.env.FORCE_COLOR = '1';

import { vi, describe, it, expect, beforeEach, afterAll } from 'vitest';

vi.hoisted(() => {
  process.env.LEOW3BOT_HOME = `/tmp/leow3bot-sp-test-${process.pid}`;
});

const sdk = vi.hoisted(() => ({
  modelsImpl: async () => ({ data: [] as Array<{ id: string; created_at: string }> }),
}));

vi.mock('../../src/llm.js', () => ({
  getClient: () => ({ models: { list: () => sdk.modelsImpl() } }),
}));

import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { render } from 'ink-testing-library';
import SubagentPicker from '../../src/components/SubagentPicker.js';
import { getState, setPhase } from '../../src/store.js';
import { getSubagentModel } from '../../src/config.js';

const HOME = process.env.LEOW3BOT_HOME!;
const CFG = path.join(HOME, '.leow3bot', 'config.json');
// 假 stdin 有一次写入滞后：每次 write 只冲刷上一次的数据。跟一个空串 write
// 即时冲刷本键（空串解析为无按键事件的 no-op，对各 picker 的分支判断无害）。
const press = (stdin: { write: (s: string) => void }, s: string): void => {
  stdin.write(s);
  stdin.write('');
};
const DOWN = '\u001B[B';   // ↓
const ENTER = '\r';
const ESC = '\u001B';

beforeEach(() => {
  mkdirSync(path.join(HOME, '.leow3bot'), { recursive: true });
  sdk.modelsImpl = async () => ({
    data: [
      { id: 'glm-sub-a', created_at: '2026-01-01T00:00:00Z' },
      { id: 'glm-sub-b', created_at: '2025-06-01T00:00:00Z' },
    ],
  });
  const committed = getState().committed;
  committed.splice(0, committed.length);
  setPhase('subagent_picker');
});
afterAll(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* noop */ } });

describe('SubagentPicker', () => {
  it('首项为「跟随主模型」（默认继承），列表含端点模型', async () => {
    const { lastFrame, unmount } = render(<SubagentPicker />);
    await vi.waitFor(() => { expect(lastFrame()).toContain('glm-sub-a'); });
    const f = lastFrame() ?? '';
    expect(f).toContain('子代理模型');
    expect(f).toContain('跟随主模型');
    expect(f).toContain('glm-sub-b');
    unmount();
  });

  it('↓ + Enter 选择指定模型：subagentModel 持久化 + 反馈', async () => {
    const { lastFrame, stdin, unmount } = render(<SubagentPicker />);
    await vi.waitFor(() => { expect(lastFrame()).toContain('glm-sub-a'); });
    press(stdin, DOWN); // → glm-sub-a
    await vi.waitFor(() => { expect(lastFrame()).toContain('▶ glm-sub-a'); }); // 等重渲染（见 model-picker 注）
    await new Promise(r => setTimeout(r, 50)); // 帧可见 ≠ effect 重绑完成，再等一拍
    press(stdin, ENTER);
    await vi.waitFor(() => { expect(getState().phase).toBe('idle'); });
    expect(getSubagentModel()).toBe('glm-sub-a');
    expect(JSON.parse(readFileSync(CFG, 'utf-8')).subagentModel).toBe('glm-sub-a');
    const sys = getState().committed.find(i => i.kind === 'system') as { text?: string };
    expect(sys?.text).toContain('✓ 子代理模型已设置: glm-sub-a');
    unmount();
  });

  it('光标自动停在当前生效项（再次进入选中 glm-sub-a）', async () => {
    const { lastFrame, unmount } = render(<SubagentPicker />);
    await vi.waitFor(() => { expect(lastFrame()).toContain('● glm-sub-a'); }); // 当前项打标
    unmount();
  });

  it('↑ 回首项 + Enter → 恢复跟随主模型（清空 subagentModel）', async () => {
    // 前一测试后 current=glm-sub-a，光标自动停在 idx1
    setPhase('subagent_picker');
    const { lastFrame, stdin, unmount } = render(<SubagentPicker />);
    await vi.waitFor(() => { expect(lastFrame()).toContain('● glm-sub-a'); });
    press(stdin, '\u001B[A'); // ↑ 回首项「跟随主模型」
    await vi.waitFor(() => { expect(lastFrame()).toContain('▶ 跟随主模型'); });
    await new Promise(r => setTimeout(r, 50)); // 同上
    press(stdin, ENTER);
    await vi.waitFor(() => { expect(getState().phase).toBe('idle'); });
    expect(getSubagentModel()).toBeNull();
    const sys = getState().committed.find(i => i.kind === 'system') as { text?: string };
    expect(sys?.text).toContain('✓ 子代理模型已恢复跟随主模型');
    unmount();
  });

  it('Esc 取消：不改动', async () => {
    const before = getSubagentModel();
    const { lastFrame, stdin, unmount } = render(<SubagentPicker />);
    await vi.waitFor(() => { expect(lastFrame()).toContain('跟随主模型'); });
    press(stdin, ESC);
    await vi.waitFor(() => { expect(getState().phase).toBe('idle'); });
    expect(getSubagentModel()).toBe(before);
    unmount();
  });
});
