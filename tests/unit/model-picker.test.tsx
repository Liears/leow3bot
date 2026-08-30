// ModelPicker 交互测试：列表加载/排序/光标定位（↑↓）/Enter 切换持久化/Esc 取消/
// 错误与空列表分支。mock getClient 的 /v1/models；LEOW3BOT_HOME 隔离 applyRuntimeConfig 写盘。
process.env.FORCE_COLOR = '1';

import { vi, describe, it, expect, beforeEach, afterAll } from 'vitest';

vi.hoisted(() => {
  process.env.LEOW3BOT_HOME = `/tmp/leow3bot-mp-test-${process.pid}`;
});

const sdk = vi.hoisted(() => ({
  modelsImpl: async () => ({ data: [] as Array<{ id: string; created_at: string }> }),
}));

vi.mock('../../src/llm.js', () => ({
  getClient: () => ({ models: { list: () => sdk.modelsImpl() } }),
}));

import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { render } from 'ink-testing-library';
import ModelPicker from '../../src/components/ModelPicker.js';
import { getState, setPhase } from '../../src/store.js';
import { MODEL } from '../../src/config.js';

const HOME = process.env.LEOW3BOT_HOME!;
const CFG = path.join(HOME, '.leow3bot', 'config.json');

const MODELS = [
  { id: 'glm-old', created_at: '2025-01-01T00:00:00Z' },
  { id: 'glm-newest', created_at: '2026-06-01T00:00:00Z' },
  { id: 'glm-mid', created_at: '2025-12-01T00:00:00Z' },
];

beforeEach(() => {
  mkdirSync(path.join(HOME, '.leow3bot'), { recursive: true });
  sdk.modelsImpl = async () => ({ data: MODELS });
  const committed = getState().committed;
  committed.splice(0, committed.length);
  setPhase('model_picker');
});
afterAll(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* noop */ } });

// 假 stdin 有一次写入滞后：每次 write 只冲刷上一次的数据。跟一个空串 write
// 即时冲刷本键（空串解析为无按键事件的 no-op，对各 picker 的分支判断无害）。
const press = (stdin: { write: (s: string) => void }, s: string): void => {
  stdin.write(s);
  stdin.write('');
};
const DOWN = '\u001B[B';   // ↓
const ENTER = '\r';
const ESC = '\u001B';

describe('ModelPicker', () => {
  it('列表按 created_at 降序（新→旧），光标默认停首项', async () => {
    const { lastFrame, unmount } = render(<ModelPicker />);
    await vi.waitFor(() => { expect(lastFrame()).toContain('glm-newest'); });
    const f = (lastFrame() ?? '').replace(/\s+/g, ' '); // 多段 <Text> 拼接产生连续空格，归一化后断言
    expect(f).toContain('模型切换');
    expect(f).toContain('共 3 个（新→旧）');
    // 排序：newest 在 mid 前，mid 在 old 前
    expect(f.indexOf('glm-newest')).toBeLessThan(f.indexOf('glm-mid'));
    expect(f.indexOf('glm-mid')).toBeLessThan(f.indexOf('glm-old'));
    expect(f).toContain('▶ glm-newest'); // 光标在首项
    unmount();
    await new Promise(r => setTimeout(r, 30)); // 冲刷异步 unmount 的 effect 清理（解绑输入监听）
  });

  it('↓ 移动光标，Enter 切换：写盘 + live binding + meta + commit + 回 idle', async () => {
    const before = MODEL;
    const { lastFrame, stdin, unmount } = render(<ModelPicker />);
    await vi.waitFor(() => { expect(lastFrame()).toContain('glm-newest'); });
    press(stdin, DOWN); // → glm-mid
    // 等 React 重渲染：同 tick 连按会让 Enter 闭包读到旧的 selected（useInput 随渲染重绑）
    await vi.waitFor(() => { expect((lastFrame() ?? '').replace(/\s+/g, ' ')).toContain('▶ glm-mid'); });
    // 帧可见 ≠ useInput 的 effect 已用新闭包重绑（vitest 调度下有窗口期）——
    // 下一键读取上一键写入的状态时，帧等待之后必须再等一个 macrotask
    await new Promise(r => setTimeout(r, 50));
    press(stdin, ENTER);
    await vi.waitFor(() => { expect(getState().phase).toBe('idle'); });
    expect(MODEL).toBe('glm-mid'); // live binding 运行时生效
    expect(MODEL).not.toBe(before);
    expect(JSON.parse(readFileSync(CFG, 'utf-8')).model).toBe('glm-mid'); // 持久化
    expect(getState().meta?.model).toBe('glm-mid'); // 状态栏立即更新
    const sys = getState().committed.find(i => i.kind === 'system') as { text?: string };
    expect(sys?.text).toContain('✓ 模型已切换: glm-mid'); // 切换反馈
    unmount();
    await new Promise(r => setTimeout(r, 30)); // 冲刷异步 unmount 的 effect 清理（解绑输入监听）
  });

  it('选的就是当前模型 → 静默退出（无切换反馈）', async () => {
    // 上一测试已把 MODEL 切到 glm-mid；重新渲染时光标自动停在当前模型
    const { lastFrame, stdin, unmount } = render(<ModelPicker />);
    await vi.waitFor(() => { expect(lastFrame()).toContain('glm-mid'); });
    await new Promise(r => setTimeout(r, 50)); // 再等一拍：给 effect 重绑留足时间
    press(stdin, ENTER);
    await vi.waitFor(() => { expect(getState().phase).toBe('idle'); });
    const sys = getState().committed.find(i => i.kind === 'system') as { text?: string };
    expect(sys?.text ?? '').not.toContain('模型已切换'); // 静默
    unmount();
    await new Promise(r => setTimeout(r, 30)); // 冲刷异步 unmount 的 effect 清理（解绑输入监听）
  });

  it('Esc 取消：不切换不写盘，回 idle', async () => {
    const modelBefore = MODEL;
    const { lastFrame, stdin, unmount } = render(<ModelPicker />);
    await vi.waitFor(() => { expect(lastFrame()).toContain('glm-newest'); });
    press(stdin, ESC);
    await vi.waitFor(() => { expect(getState().phase).toBe('idle'); });
    expect(MODEL).toBe(modelBefore);
    unmount();
    await new Promise(r => setTimeout(r, 30)); // 冲刷异步 unmount 的 effect 清理（解绑输入监听）
  });

  it('列表获取失败 → 错误提示，Enter 返回', async () => {
    sdk.modelsImpl = async () => { throw new Error('HTTP 500'); };
    setPhase('model_picker');
    const { lastFrame, stdin, unmount } = render(<ModelPicker />);
    await vi.waitFor(() => { expect(lastFrame()).toContain('模型列表获取失败'); });
    await new Promise(r => setTimeout(r, 50)); // 再等一拍：给 effect 重绑留足时间
    press(stdin, ENTER);
    await vi.waitFor(() => { expect(getState().phase).toBe('idle'); });
    unmount();
    await new Promise(r => setTimeout(r, 30)); // 冲刷异步 unmount 的 effect 清理（解绑输入监听）
  });

  it('空列表 → 端点未返回任何模型', async () => {
    sdk.modelsImpl = async () => ({ data: [] });
    setPhase('model_picker');
    const { lastFrame, unmount } = render(<ModelPicker />);
    await vi.waitFor(() => { expect(lastFrame()).toContain('端点未返回任何模型'); });
    unmount();
    await new Promise(r => setTimeout(r, 30)); // 冲刷异步 unmount 的 effect 清理（解绑输入监听）
  });
});
