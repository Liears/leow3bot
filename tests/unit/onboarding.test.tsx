// Onboarding 四步引导测试：URL 归一化与校验 → key 必填 → 模型列表（fetch mock，
// 失败退化手动输入）→ 上下文窗口校验 → onDone 收到完整四元组。
// 打字 = write(文本)（整串一次 onChange 即可），提交 = press(回车)；连续输入间 settle。
process.env.FORCE_COLOR = '1';

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import stripAnsi from 'strip-ansi';
import { render } from 'ink-testing-library';
import Onboarding from '../../src/components/Onboarding.js';
import { DEFAULT_API_BASE_URL } from '../../src/config.js';

const press = (stdin: { write: (s: string) => void }, s: string): void => {
  stdin.write(s);
  stdin.write('');
};
const type = (stdin: { write: (s: string) => void }, text: string): void => {
  stdin.write(text); // 整串一次到达 = 一次 onChange
  stdin.write('');   // 冲刷一次写入滞后（同 press）；回车必须另行单独按下
};
const settle = () => new Promise(r => setTimeout(r, 50));
const ENTER = '\r';
const norm = (s: string) => stripAnsi(s).replace(/\s+/g, ' ');

function mockModelsFetch(ids: string[]): void {
  // created_at 递减：数组首个 = 最新（组件按 created_at 降序排，首个应即 ids[0]）
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ data: ids.map((id, i) => ({ id, created_at: `2026-0${ids.length - i}-01T00:00:00Z` })) }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )));
}

beforeEach(() => { mockModelsFetch(['glm-new', 'glm-old']); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('Onboarding', () => {
  it('① 无效端点被拦截，有效裸域名补 https 后进入 key 步', async () => {
    const onDone = vi.fn();
    const { lastFrame, stdin, unmount } = render(<Onboarding onDone={onDone} />);
    await settle();
    type(stdin, '|||invalid|||');
    await settle();
    press(stdin, ENTER);
    await vi.waitFor(() => { expect(norm(lastFrame() ?? '')).toContain('端点 URL 无效'); });
    await settle(); // 帧可见 ≠ effect 重绑完成（TextInput 的 onSubmit 同理）
    expect(onDone).not.toHaveBeenCalled();

    unmount();
    await settle();

    // 新实例：合法裸域名自动补 https://
    const r2 = render(<Onboarding onDone={onDone} />);
    await settle();
    type(r2.stdin, 'bigmodel.cn/api/anthropic');
    await settle();
    press(r2.stdin, ENTER);
    await vi.waitFor(() => { expect(norm(r2.lastFrame() ?? '')).toContain('② API Key'); });
    await settle(); // 帧可见 ≠ effect 重绑完成（TextInput 的 onSubmit 同理）
    expect(onDone).not.toHaveBeenCalled();
    r2.unmount();
    await settle();
  });

  it('② key 必填；四步完整走通（列表选模型 + 自定义上下文）→ onDone 四元组', async () => {
    const onDone = vi.fn();
    const { lastFrame, stdin, unmount } = render(<Onboarding onDone={onDone} />);
    await settle();
    // ① 端点：默认（直接回车 = DEFAULT_API_BASE_URL）
    press(stdin, ENTER);
    await vi.waitFor(() => { expect(norm(lastFrame() ?? '')).toContain('② API Key'); });
    await settle(); // 帧可见 ≠ effect 重绑完成（TextInput 的 onSubmit 同理）
    // ② 空 key 回车 → 报错；填 key 回车 → 模型步
    press(stdin, ENTER);
    await vi.waitFor(() => { expect(norm(lastFrame() ?? '')).toContain('API Key 不能为空'); });
    await settle(); // 帧可见 ≠ effect 重绑完成（TextInput 的 onSubmit 同理）
    type(stdin, '  sk-test-key-123  ');
    await settle();
    press(stdin, ENTER);
    await vi.waitFor(() => { expect(norm(lastFrame() ?? '')).toContain('③ 选择模型'); });
    await settle(); // 帧可见 ≠ effect 重绑完成（TextInput 的 onSubmit 同理）
    // 模型列表来自 fetch mock（created_at 降序 → glm-new 在前）
    await vi.waitFor(() => { expect(norm(lastFrame() ?? '')).toContain('glm-new'); });
    await settle(); // 帧可见 ≠ effect 重绑完成（TextInput 的 onSubmit 同理）
    expect(norm(lastFrame() ?? '')).toContain('共 2 个');
    press(stdin, ENTER); // 选首个 glm-new
    await vi.waitFor(() => { expect(norm(lastFrame() ?? '')).toContain('④ 上下文窗口'); });
    await settle(); // 帧可见 ≠ effect 重绑完成（TextInput 的 onSubmit 同理）
    // ④ 非法值拦截 → 合法值完成
    type(stdin, '99');
    await settle();
    press(stdin, ENTER);
    await vi.waitFor(() => { expect(norm(lastFrame() ?? '')).toContain('4096 - 10000000'); });
    await settle(); // 帧可见 ≠ effect 重绑完成（TextInput 的 onSubmit 同理）
    unmount();

    // 重新走一遍输入 128000（组件已进 context 步——直接续用上一实例不可行，重开）
    const r2 = render(<Onboarding onDone={onDone} />);
    const s2 = r2.stdin;
    await settle();
    press(s2, ENTER); // ① 默认端点
    await vi.waitFor(() => { expect(norm(r2.lastFrame() ?? '')).toContain('② API Key'); });
    await settle(); // 帧可见 ≠ effect 重绑完成（TextInput 的 onSubmit 同理）
    type(s2, 'sk-test-key-123');
    await settle();
    press(s2, ENTER);
    await vi.waitFor(() => { expect(norm(r2.lastFrame() ?? '')).toContain('③ 选择模型'); });
    await settle(); // 帧可见 ≠ effect 重绑完成（TextInput 的 onSubmit 同理）
    await vi.waitFor(() => { expect(norm(r2.lastFrame() ?? '')).toContain('glm-new'); });
    await settle(); // 帧可见 ≠ effect 重绑完成（TextInput 的 onSubmit 同理）
    press(s2, ENTER);
    await vi.waitFor(() => { expect(norm(r2.lastFrame() ?? '')).toContain('④ 上下文窗口'); });
    await settle(); // 帧可见 ≠ effect 重绑完成（TextInput 的 onSubmit 同理）
    type(s2, '128000');
    await settle();
    press(s2, ENTER);
    await vi.waitFor(() => { expect(onDone).toHaveBeenCalledTimes(1); });
    await settle(); // 帧可见 ≠ effect 重绑完成（TextInput 的 onSubmit 同理）
    expect(onDone).toHaveBeenCalledWith({
      apiBaseUrl: DEFAULT_API_BASE_URL,
      apiKey: 'sk-test-key-123', // trim 过
      model: 'glm-new',
      contextWindow: 128000,
    });
    r2.unmount();
    await settle();
  });

  it('③ 模型列表失败 → 退化手动输入', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const onDone = vi.fn();
    const { lastFrame, stdin, unmount } = render(<Onboarding onDone={onDone} />);
    await settle();
    press(stdin, ENTER); // ① 默认端点
    await vi.waitFor(() => { expect(norm(lastFrame() ?? '')).toContain('② API Key'); });
    await settle(); // 帧可见 ≠ effect 重绑完成（TextInput 的 onSubmit 同理）
    type(stdin, 'sk-k');
    await settle();
    press(stdin, ENTER);
    // fetch 失败 → 手动输入模型名
    await vi.waitFor(() => { expect(norm(lastFrame() ?? '')).toContain('列表获取失败，手动输入'); });
    await settle(); // 帧可见 ≠ effect 重绑完成（TextInput 的 onSubmit 同理）
    type(stdin, 'glm-manual');
    await settle();
    press(stdin, ENTER);
    await vi.waitFor(() => { expect(norm(lastFrame() ?? '')).toContain('④ 上下文窗口'); });
    await settle(); // 帧可见 ≠ effect 重绑完成（TextInput 的 onSubmit 同理）
    press(stdin, ENTER); // 空回车 = 默认 192000
    await vi.waitFor(() => { expect(onDone).toHaveBeenCalledTimes(1); });
    await settle(); // 帧可见 ≠ effect 重绑完成（TextInput 的 onSubmit 同理）
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ model: 'glm-manual', contextWindow: 192000 }));
    unmount();
    await settle();
  });

  it('④ 空回车 → 默认 192000；key 显示脱敏（前6后4）', async () => {
    const onDone = vi.fn();
    const { lastFrame, stdin, unmount } = render(<Onboarding onDone={onDone} />);
    await settle();
    press(stdin, ENTER);
    await vi.waitFor(() => { expect(norm(lastFrame() ?? '')).toContain('② API Key'); });
    await settle(); // 帧可见 ≠ effect 重绑完成（TextInput 的 onSubmit 同理）
    type(stdin, 'sk-abcdefgh1234');
    await settle();
    press(stdin, ENTER);
    await vi.waitFor(() => { expect(norm(lastFrame() ?? '')).toContain('sk-abc…1234'); }); // 脱敏回显（前6后4）
    await vi.waitFor(() => { expect(norm(lastFrame() ?? '')).toContain('③ 选择模型'); });
    await settle(); // 帧可见 ≠ effect 重绑完成（TextInput 的 onSubmit 同理）
    press(stdin, ENTER); // 选模型
    await vi.waitFor(() => { expect(norm(lastFrame() ?? '')).toContain('④ 上下文窗口'); });
    await settle(); // 帧可见 ≠ effect 重绑完成（TextInput 的 onSubmit 同理）
    press(stdin, ENTER); // 空回车 = 默认
    await vi.waitFor(() => { expect(onDone).toHaveBeenCalledTimes(1); });
    await settle(); // 帧可见 ≠ effect 重绑完成（TextInput 的 onSubmit 同理）
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ contextWindow: 192000, apiKey: 'sk-abcdefgh1234' }));
    unmount();
    await settle();
  });
});
