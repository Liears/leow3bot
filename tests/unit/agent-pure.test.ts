// Agent 纯函数单测（agent.ts）：stripHistoricalThinking（图片轮 thinking 保留 /
// 文本轮剥离 / 空占位）、repairInterruptedToolCalls（孤儿 tool_use 合成结果）、
// buildSystem（skill/web/agent 菜单注入）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stripHistoricalThinking, repairInterruptedToolCalls, buildSystem, setSystem, getSystem } from '../../src/agent.js';
import { loadSkills } from '../../src/skills.js';
import { loadAgents } from '../../src/subagents/loader.js';
import { SYSTEM_PROMPT } from '../../src/config.js';
import type { MessageParam, ContentBlock } from '../../src/types.js';

const img = (): ContentBlock => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } });
const thinking = (t: string): ContentBlock => ({ type: 'thinking', thinking: t });
const blocksOf = (m: MessageParam): ContentBlock[] => (Array.isArray(m.content) ? m.content : []);

describe('stripHistoricalThinking', () => {
  it('普通文本轮：thinking 剥离，text 保留', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: '问题' },
      { role: 'assistant', content: [thinking('内部推理'), { type: 'text', text: '回答' }] },
    ];
    stripHistoricalThinking(messages);
    expect(blocksOf(messages[1]).map(b => b.type)).toEqual(['text']);
  });

  it('图片轮（相邻 user 有 image 块）：thinking 保留——驱逐后是唯一在场记忆', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: [img()] },
      { role: 'assistant', content: [thinking('图上有个红色按钮'), { type: 'text', text: '见图' }] },
    ];
    stripHistoricalThinking(messages);
    expect(blocksOf(messages[1]).map(b => b.type)).toEqual(['thinking', 'text']);
  });

  it('驱逐标记轮（图片已释放，标记文本仍在）：thinking 保留（跨轮持久判定）', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: [{ type: 'text', text: '[历史粘贴图片已释放]' }] },
      { role: 'assistant', content: [thinking('对图的观察'), { type: 'text', text: '结论' }] },
    ];
    stripHistoricalThinking(messages);
    expect(blocksOf(messages[1]).some(b => b.type === 'thinking')).toBe(true);
  });

  it('tool_result 内嵌驱逐标记同样算图片轮证据', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '[图片已释放——可按上方路径重新 view]' }] }] },
      { role: 'assistant', content: [thinking('观察'), { type: 'tool_use', id: 'u1', name: 'read', input: {} }] },
    ];
    stripHistoricalThinking(messages);
    expect(blocksOf(messages[1]).some(b => b.type === 'thinking')).toBe(true);
  });

  it('整条只剩 thinking（中断轮）：剥离后注入占位文本块（防空 content 400）', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [thinking('只思考了没输出')] },
    ];
    stripHistoricalThinking(messages);
    expect(blocksOf(messages[1])).toEqual([{ type: 'text', text: '(此轮无正文输出)' }]);
  });
});

describe('repairInterruptedToolCalls', () => {
  it('未应答的 tool_use 合成 tool_result 注入下一条 user 消息', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'bash', input: { command: 'ls' } }] },
      { role: 'user', content: [{ type: 'text', text: '继续' }] },
    ];
    repairInterruptedToolCalls(messages);
    const next = blocksOf(messages[2]);
    expect(next[0].type).toBe('tool_result');
    expect((next[0] as { tool_use_id: string }).tool_use_id).toBe('u1');
    expect(String((next[0] as { content: unknown }).content)).toContain('已被中断');
    expect(next[1]).toEqual({ type: 'text', text: '继续' }); // 原文本保留在合成结果之后
  });

  it('下一条不是 user 时插入新 user 消息', () => {
    const messages: MessageParam[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'bash', input: {} }] },
      { role: 'assistant', content: [{ type: 'text', text: '回复' }] },
    ];
    repairInterruptedToolCalls(messages);
    expect(messages[1].role).toBe('user');
    expect((blocksOf(messages[1])[0] as { tool_use_id: string }).tool_use_id).toBe('u1');
  });

  it('已应答的 tool_use 不重复合成', () => {
    const messages: MessageParam[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'ok' }] },
    ];
    repairInterruptedToolCalls(messages);
    expect(blocksOf(messages[1])).toHaveLength(1);
  });
});

describe('buildSystem', () => {
  const skillDir = mkdtempSync(path.join(tmpdir(), 'leow3bot-skills-sys-'));

  beforeAll(() => {
    mkdirSync(path.join(skillDir, 'demo-skill'), { recursive: true });
    writeFileSync(path.join(skillDir, 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: 演示技能描述\n---\n技能正文');
    loadSkills([skillDir]);
    loadAgents([]); // 内置 explore
  });

  afterAll(() => rmSync(skillDir, { recursive: true, force: true }));

  it('注入 skill 菜单 + web 工具指引 + 委派引导 + 子代理菜单', () => {
    const sys = buildSystem();
    setSystem(sys);
    expect(sys.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(sys).toContain('demo-skill: 演示技能描述');
    expect(sys).toContain('web_search（联网搜索');
    expect(sys).toContain('委派广度，亲为深度');
    expect(sys).toContain('explore:'); // 内置子代理菜单
  });

  it('setSystem/getSystem 往返', () => {
    setSystem('自定义');
    expect(getSystem()).toBe('自定义');
    setSystem(buildSystem());
  });
});
