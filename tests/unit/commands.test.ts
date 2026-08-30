// 斜杠命令单测（commands.ts）：parseCommand 解析 + handleCommand 各分支。
// vi.mock llm（countTokens/models.list 不发真网络）；LEOW3BOT_HOME 隔离
// session 写盘（/save 等命令会落盘）。
import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';

vi.hoisted(() => {
  process.env.LEOW3BOT_HOME = `/tmp/leow3bot-cmd-test-${process.pid}`;
});
vi.mock('../../src/llm.js', () => ({
  countTokens: vi.fn(async () => null), // /context 走"端点不支持"分支
  getClient: vi.fn(() => ({
    models: { list: vi.fn(async () => { throw new Error('mock 网络失败'); }) },
    messages: { create: vi.fn(async () => ({ content: [] })) },
  })),
}));

import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseCommand, handleCommand, type CmdCtx } from '../../src/commands.js';
import { MODEL } from '../../src/config.js';
import { getState, setPhase } from '../../src/store.js';
import type { MessageParam } from '../../src/types.js';

const HOME = process.env.LEOW3BOT_HOME!;

function makeCtx(messages: MessageParam[] = []): CmdCtx & { cleared: boolean } {
  let msgs = messages;
  return {
    showCtx: true, showPerf: true, showThinking: true,
    toggleCtx: () => {}, togglePerf: () => {}, toggleThinking: () => {},
    clearMessages: () => { msgs = []; },
    getMessages: () => msgs,
    setMessages: (m: MessageParam[]) => { msgs = m; },
    get cleared() { return msgs.length === 0; },
  } as CmdCtx & { cleared: boolean };
}

beforeAll(() => { mkdirSync(path.join(HOME, '.leow3bot'), { recursive: true }); setPhase('idle'); });
afterAll(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* noop */ } });

describe('parseCommand', () => {
  it('非 / 开头 → null', () => expect(parseCommand('hello')).toBeNull());
  it('仅 / → null', () => expect(parseCommand('/')).toBeNull());
  it('空白 → null', () => expect(parseCommand('   ')).toBeNull());
  it('命令小写化 + 参数拆分', () => {
    expect(parseCommand('/Model  GLM-5  ')).toEqual({ cmd: 'model', args: ['GLM-5'] });
  });
  it('/load 带多参数', () => {
    expect(parseCommand('/load a b')).toEqual({ cmd: 'load', args: ['a', 'b'] });
  });
});

describe('handleCommand', () => {
  it('help 列出全部命令', async () => {
    const r = await handleCommand('help', [], makeCtx());
    expect(r?.output).toContain('/clear');
    expect(r?.output).toContain('/model');
  });

  it('未知命令 → err 提示', async () => {
    const r = await handleCommand('nosuch', [], makeCtx());
    expect(r?.tone).toBe('err');
    expect(r?.output).toContain('未知命令');
  });

  it('q/quit/exit → exit: true', async () => {
    expect((await handleCommand('q', [], makeCtx()))?.exit).toBe(true);
    expect((await handleCommand('quit', [], makeCtx()))?.exit).toBe(true);
    expect((await handleCommand('exit', [], makeCtx()))?.exit).toBe(true);
  });

  it('perf / verbose 输出开关状态', async () => {
    expect((await handleCommand('perf', [], makeCtx()))?.output).toContain('perf 状态栏');
    expect((await handleCommand('verbose', [], makeCtx()))?.output).toContain('思考过程');
  });

  it('clear 清空消息', async () => {
    const ctx = makeCtx([{ role: 'user', content: 'hi' }]);
    await handleCommand('clear', [], ctx);
    expect(ctx.cleared).toBe(true);
  });

  it('history 列出消息（空 → 提示）', async () => {
    expect((await handleCommand('history', [], makeCtx([])))?.output).toContain('对话历史为空');
    const r = await handleCommand('history', [], makeCtx([
      { role: 'user', content: '第一条消息' },
      { role: 'assistant', content: [{ type: 'text', text: '回复' }] },
    ]));
    expect(r?.output).toContain('第一条消息');
    expect(r?.output).toContain('2 条');
  });

  it('tools 列出工具名', async () => {
    const r = await handleCommand('tools', [], makeCtx());
    expect(r?.output).toContain('bash');
    expect(r?.output).toContain('read');
  });

  it('context：countTokens 不可用 → err 提示', async () => {
    const r = await handleCommand('context', [], makeCtx());
    expect(r?.tone).toBe('err');
    expect(r?.output).toContain('countTokens 不可用');
  });

  it('model 带参：校验失败宽松放行 + 运行时切换 + 写盘', async () => {
    const before = MODEL;
    const r = await handleCommand('model', ['glm-test-model'], makeCtx());
    expect(r?.tone).toBe('ok');
    expect(r?.output).toContain('glm-test-model');
    expect(MODEL).toBe('glm-test-model'); // live binding 运行时生效
    expect(JSON.parse(readFileSync(path.join(HOME, '.leow3bot', 'config.json'), 'utf-8')).model).toBe('glm-test-model');
    expect(before).toBeTruthy();
  });

  it('model 无参 → 进入 model_picker phase', async () => {
    setPhase('idle');
    const r = await handleCommand('model', [], makeCtx());
    expect(r).toBeUndefined();
    expect(getState().phase).toBe('model_picker');
    setPhase('idle');
  });

  it('subagent → subagent_picker phase', async () => {
    const r = await handleCommand('subagent', [], makeCtx());
    expect(r).toBeUndefined();
    expect(getState().phase).toBe('subagent_picker');
    setPhase('idle');
  });

  it('skills → skills_picker phase', async () => {
    await handleCommand('skills', [], makeCtx());
    expect(getState().phase).toBe('skills_picker');
    setPhase('idle');
  });

  it('save + load 往返（隔离 HOME 下落盘）', async () => {
    const msgs: MessageParam[] = [
      { role: 'user', content: '测试保存的消息' },
      { role: 'assistant', content: [{ type: 'text', text: '回复' }] },
    ];
    const r = await handleCommand('save', ['测试会话'], makeCtx(msgs));
    expect(r?.tone).toBe('ok');
    expect(r?.output).toContain(HOME); // 落盘在隔离 HOME 内

    // load 无参 → 列表
    const list = await handleCommand('load', [], makeCtx(msgs));
    expect(list?.output).toContain('测试会话');

    // load 序号 1 → 加载
    const ctx = makeCtx([]);
    const loaded = await handleCommand('load', ['1'], ctx);
    expect(loaded?.tone).toBe('ok');
    expect(ctx.getMessages()).toHaveLength(2);

    // load 无效序号
    expect((await handleCommand('load', ['99'], makeCtx(msgs)))?.tone).toBe('err');
    // load 找不到的文件
    expect((await handleCommand('load', ['nosuch-file'], makeCtx(msgs)))?.tone).toBe('err');
  });

  it('sessions 列表 / 空时提示', async () => {
    const r = await handleCommand('sessions', [], makeCtx());
    expect(r?.output).toContain('测试会话');
  });

  it('status 提示用法', async () => {
    expect((await handleCommand('status', [], makeCtx()))?.output).toContain('/context');
  });

  it('compact 压缩媒体消息', async () => {
    const msgs: MessageParam[] = [
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }] },
      { role: 'assistant', content: [{ type: 'text', text: '分析' }] },
    ];
    const r = await handleCommand('compact', [], makeCtx(msgs));
    expect(r?.tone).toBe('ok');
    expect(r?.output).toContain('1 条媒体');
  });
});
