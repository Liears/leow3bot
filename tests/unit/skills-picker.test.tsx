// SkillsPicker 交互测试：列表渲染/↑↓ 边界/Tab 开关切换（持久化到隔离 home 的
// skills.json）/Enter 完成。假 stdin 按键注入——两个已知坑（详见 model-picker 注）：
// ① write(key) 后跟 write('') 冲刷一次写入滞后；② 帧可见 ≠ useInput effect 已用
// 新闭包重绑，连续按键间须等一个 macrotask。
process.env.FORCE_COLOR = '1';

import { vi, describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';

vi.hoisted(() => {
  process.env.LEOW3BOT_HOME = `/tmp/leow3bot-skp-test-${process.pid}`;
});

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import stripAnsi from 'strip-ansi';
import { render } from 'ink-testing-library';
import SkillsPicker from '../../src/components/SkillsPicker.js';
import { loadSkills, getSkillListing } from '../../src/skills.js';

const HOME = process.env.LEOW3BOT_HOME!;
const SKILLS_JSON = path.join(HOME, '.leow3bot', 'skills.json');
const dir = mkdtempSync(path.join(tmpdir(), 'leow3bot-skills-picker-'));

const press = (stdin: { write: (s: string) => void }, s: string): void => {
  stdin.write(s);
  stdin.write('');
};
const settle = () => new Promise(r => setTimeout(r, 50));
const DOWN = '\u001B[B';
const UP = '\u001B[A';
const TAB = '\t';
const ENTER = '\r';
const norm = (s: string) => stripAnsi(s).replace(/\s+/g, ' ');

beforeAll(() => {
  mkdirSync(path.join(HOME, '.leow3bot'), { recursive: true });
  mkdirSync(path.join(dir, 'alpha'), { recursive: true });
  writeFileSync(path.join(dir, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: 技能甲说明\n---\n甲');
  mkdirSync(path.join(dir, 'beta'), { recursive: true });
  writeFileSync(path.join(dir, 'beta', 'SKILL.md'), '---\nname: beta\ndescription: 技能乙说明\n---\n乙');
});
// 每个测试从「全部启用」起步：删状态文件 + 重扫（disabled 状态是模块级，跨测试残留）
beforeEach(() => {
  try { unlinkSync(SKILLS_JSON); } catch { /* 不存在 */ }
  loadSkills([dir]);
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('SkillsPicker', () => {
  it('列表渲染（名称 + 启用标记 + 说明），光标在首项', async () => {
    const { lastFrame, unmount } = render(<SkillsPicker onDone={() => {}} />);
    await settle();
    const f = norm(lastFrame() ?? '');
    expect(f).toContain('skills 开关');
    expect(f).toContain('共 2 个');
    expect(f).toContain('▶ ✅ alpha — 技能甲说明');
    expect(f).toContain('✅ beta — 技能乙说明');
    unmount();
    await settle();
  });

  it('Tab 切换选中项：禁用 + 写盘 + listing 不再包含；再 Tab 恢复', async () => {
    const { lastFrame, stdin, unmount } = render(<SkillsPicker onDone={() => {}} />);
    await settle();
    press(stdin, TAB); // 禁用 alpha
    await vi.waitFor(() => { expect(norm(lastFrame() ?? '')).toContain('⛔ alpha'); });
    expect(JSON.parse(readFileSync(SKILLS_JSON, 'utf-8')).disabled).toContain('alpha');
    expect(getSkillListing()).not.toContain('技能甲说明'); // listing 只含启用的
    await settle(); // effect 重绑完成再按（否则 handler 的 skills memo 还是旧的）
    press(stdin, TAB); // 再 Tab 恢复
    await vi.waitFor(() => { expect(norm(lastFrame() ?? '')).toContain('✅ alpha'); });
    expect(getSkillListing()).toContain('技能甲说明');
    unmount();
    await settle();
  });

  it('↓ 到底不再越界，↑ 回顶；Enter 完成', async () => {
    const onDone = vi.fn();
    const { lastFrame, stdin, unmount } = render(<SkillsPicker onDone={onDone} />);
    await settle();
    press(stdin, DOWN);
    await vi.waitFor(() => { expect(norm(lastFrame() ?? '')).toContain('▶ ✅ beta'); });
    await settle();
    press(stdin, DOWN); // 已在底部 → 光标不动
    await settle();
    press(stdin, UP);
    await vi.waitFor(() => { expect(norm(lastFrame() ?? '')).toContain('▶ ✅ alpha'); });
    await settle();
    press(stdin, ENTER);
    expect(onDone).toHaveBeenCalledTimes(1);
    unmount();
    await settle();
  });

  it('空注册表 → 空态提示', async () => {
    loadSkills([path.join(tmpdir(), 'leow3bot-no-such-skills-dir')]);
    const { lastFrame, unmount } = render(<SkillsPicker onDone={() => {}} />);
    await settle();
    expect(norm(lastFrame() ?? '')).toContain('没有加载任何 skill');
    unmount();
    loadSkills([dir]); // 恢复
    await settle();
  });
});
