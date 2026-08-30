// Skill 加载器单测（skills.ts）：扫描/覆盖/黑名单开关/$ARGUMENTS 与目录占位符。
// LEOW3BOT_HOME 隔离 skills.json 状态文件。
import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';

vi.hoisted(() => {
  process.env.LEOW3BOT_HOME = `/tmp/leow3bot-skills-test-${process.pid}`;
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadSkills, SKILLS_REGISTRY, getSkillListing, getSkillPrompt,
  enableSkill, disableSkill, listSkillsWithStatus,
} from '../../src/skills.js';

const HOME = process.env.LEOW3BOT_HOME!;
const dirA = mkdtempSync(path.join(tmpdir(), 'leow3bot-skills-a-'));
const dirB = mkdtempSync(path.join(tmpdir(), 'leow3bot-skills-b-'));

beforeAll(() => {
  mkdirSync(path.join(HOME, '.leow3bot'), { recursive: true });
  // 格式 1：dir/<sub>/SKILL.md（社区标准）
  mkdirSync(path.join(dirA, 'alpha'), { recursive: true });
  writeFileSync(path.join(dirA, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: 技能甲\n---\n甲的指引 $ARGUMENTS ${CLAUDE_SKILL_DIR}');
  mkdirSync(path.join(dirA, 'beta'), { recursive: true });
  writeFileSync(path.join(dirA, 'beta', 'SKILL.md'), '---\nname: beta\ndescription: 技能乙\n---\n乙的指引');
  // 格式 2：dir/SKILL.md 单文件（name 缺失回退目录名）
  mkdirSync(path.join(dirB, 'solo'), { recursive: true });
  writeFileSync(path.join(dirB, 'solo', 'SKILL.md'), '---\ndescription: 单文件技能\n---\n单文件正文');
  // 同名覆盖（dirB 后扫 → 覆盖 dirA）
  mkdirSync(path.join(dirB, 'alpha'), { recursive: true });
  writeFileSync(path.join(dirB, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: 覆盖版\n---\n覆盖后的正文');
});

afterAll(() => {
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('loadSkills 扫描', () => {
  it('子目录 + 单文件两种格式都识别，后扫目录覆盖同名', () => {
    loadSkills([dirA, dirB]);
    expect(SKILLS_REGISTRY.get('alpha')?.description).toBe('覆盖版');
    expect(SKILLS_REGISTRY.get('beta')?.description).toBe('技能乙');
    expect(SKILLS_REGISTRY.get('solo')?.content).toBe('单文件正文'); // name 回退目录名
  });

  it('目录不存在 → 静默跳过', () => {
    loadSkills([path.join(tmpdir(), 'leow3bot-no-such-dir')]);
    expect(SKILLS_REGISTRY.size).toBe(0);
    loadSkills([dirA, dirB]); // 恢复
  });
});

describe('getSkillListing / getSkillPrompt', () => {
  it('listing 列出启用的 skill', () => {
    loadSkills([dirA, dirB]);
    const listing = getSkillListing();
    expect(listing).toContain('alpha: 覆盖版');
    expect(listing).toContain('beta: 技能乙');
  });

  it('prompt 替换 $ARGUMENTS 与目录占位符（CLAUDE_SKILL_DIR / LEOW3BOT_SKILL_DIR）', () => {
    loadSkills([dirA, dirB]);
    const p = getSkillPrompt('beta', '参数内容');
    expect(p).toContain('乙的指引');
    const p2 = getSkillPrompt('beta');
    expect(p2).not.toContain('$ARGUMENTS');
    // alpha 正文含占位符（被覆盖版没有 → 用 dirA 单独加载验证）
    loadSkills([dirA]);
    const pa = getSkillPrompt('alpha', '输入X');
    expect(pa).toContain('输入X');
    expect(pa).toContain(path.join(dirA, 'alpha'));
    expect(pa).not.toContain('${CLAUDE_SKILL_DIR}');
    loadSkills([dirA, dirB]); // 恢复
  });

  it('未知/禁用 skill → null', () => {
    loadSkills([dirA, dirB]);
    expect(getSkillPrompt('nosuch-skill')).toBeNull();
    disableSkill('beta');
    expect(getSkillPrompt('beta')).toBeNull();
    enableSkill('beta');
    expect(getSkillPrompt('beta')).not.toBeNull();
  });
});

describe('enable/disable 持久化', () => {
  it('disable 写入 skills.json，重载后保持禁用', () => {
    loadSkills([dirA, dirB]);
    expect(disableSkill('beta')).toBe(true);
    expect(disableSkill('beta')).toBe(false); // 重复 disable 幂等
    expect(disableSkill('nosuch')).toBe(false);
    const state = JSON.parse(readFileSync(path.join(HOME, '.leow3bot', 'skills.json'), 'utf-8'));
    expect(state.disabled).toContain('beta');
    // 重新加载（loadSkills 内部 loadDisabled）→ 状态保持
    loadSkills([dirA, dirB]);
    expect(listSkillsWithStatus().find(s => s.name === 'beta')?.disabled).toBe(true);
    expect(getSkillListing()).not.toContain('技能乙'); // listing 只含启用的
  });

  it('enable 恢复', () => {
    expect(enableSkill('beta')).toBe(true);
    expect(enableSkill('beta')).toBe(false); // 已启用
    loadSkills([dirA, dirB]);
    expect(listSkillsWithStatus().find(s => s.name === 'beta')?.disabled).toBe(false);
  });
});

describe('listSkillsWithStatus', () => {
  it('按名排序，带 disabled 标记', () => {
    loadSkills([dirA, dirB]);
    const list = listSkillsWithStatus();
    expect(list.map(s => s.name)).toEqual([...list.map(s => s.name)].sort((a, b) => a.localeCompare(b)));
    expect(list.some(s => s.name === 'alpha')).toBe(true);
  });
});
