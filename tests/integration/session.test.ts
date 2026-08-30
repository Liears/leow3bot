// 会话持久化集成测试（session.ts）：LEOW3BOT_HOME 隔离下的 autosave/load/resume
// roundtrip、图片压缩占位、路径穿越防护、committed 重建。
import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';

vi.hoisted(() => {
  process.env.LEOW3BOT_HOME = `/tmp/leow3bot-session-test-${process.pid}`;
});

import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  autosaveSession, loadSession, saveSession, resumeSession, listSessions,
  rebuildCommitted, setSessionTitle, getSessionTitle, refreshProject, PROJECT_ROOT,
} from '../../src/session.js';
import type { MessageParam, CommittedItem } from '../../src/types.js';

const HOME = process.env.LEOW3BOT_HOME!;
const SESSION_DIR = path.join(HOME, '.leow3bot', 'sessions');

beforeAll(() => { mkdirSync(SESSION_DIR, { recursive: true }); });
afterAll(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* noop */ } });

const sampleMessages = (): MessageParam[] => [
  { role: 'user', content: '第一条用户消息，足够长用于生成主题名称的内容' },
  { role: 'assistant', content: [{ type: 'thinking', thinking: '思考' }, { type: 'text', text: '回复正文' }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '工具输出' }, { type: 'text', text: '追加输入' }] },
];

describe('autosaveSession / loadSession roundtrip', () => {
  it('自动保存落盘 + 读回消息一致', () => {
    const msgs = sampleMessages();
    autosaveSession(msgs);
    const files = listSessions(5).filter(s => s.is_current);
    expect(files.length).toBeGreaterThan(0);
    const loaded = loadSession(files[0].filename);
    expect(loaded).toHaveLength(3);
    expect(loaded?.[1].content).toEqual(msgs[1].content);
  });

  it('图片块压缩为占位（不存 base64）', () => {
    const msgs: MessageParam[] = [
      { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }] },
    ];
    autosaveSession(msgs);
    const cur = listSessions(1).find(s => s.is_current)!;
    const raw = JSON.parse(readFileSync(cur.filepath, 'utf-8'));
    const blocks = raw.messages[0].content;
    expect(blocks[1].type).toBe('image');
    expect(blocks[1].source.type).toBe('placeholder');
    expect(blocks[1].source.note).toContain('已移除');
  });

  it('无主题时 name 取首条用户消息前 30 字符', () => {
    autosaveSession(sampleMessages());
    const cur = listSessions(1).find(s => s.is_current)!;
    expect(cur.name).toContain('第一条用户消息');
    expect(cur.name.length).toBeLessThanOrEqual(33); // 30 + '...'
  });

  it('设置主题后 name 用主题', () => {
    setSessionTitle('自定义主题');
    autosaveSession(sampleMessages());
    const cur = listSessions(1).find(s => s.is_current)!;
    expect(cur.name).toBe('自定义主题');
    setSessionTitle(''); // 空串归一 null
    expect(getSessionTitle()).toBeNull();
  });

  it('空消息不落盘', () => {
    const before = listSessions(50).length;
    autosaveSession([]);
    expect(listSessions(50).length).toBe(before);
  });
});

describe('saveSession / resumeSession', () => {
  it('显式保存返回路径，可按文件名 resume', () => {
    const fp = saveSession(sampleMessages(), '命名会话');
    expect(fp).toContain(SESSION_DIR);
    const resumed = resumeSession(path.basename(fp));
    expect(resumed?.name).toBe('命名会话');
    expect(resumed?.messages).toHaveLength(3);
    expect(resumed?.projectRoot).toBe(PROJECT_ROOT);
  });

  it('id 可带可不带 .json', () => {
    const fp = saveSession(sampleMessages(), 'x');
    const withExt = resumeSession(path.basename(fp));
    const noExt = resumeSession(path.basename(fp).replace(/\.json$/, ''));
    expect(withExt?.messages).toHaveLength(3);
    expect(noExt?.messages).toHaveLength(3);
  });

  it('相对路径穿越（../../foo）→ 拒绝', () => {
    expect(resumeSession('../../etc/passwd')).toBeNull();
  });

  it('畸形文件（非数组 messages）→ null', () => {
    writeFileSync(path.join(SESSION_DIR, 'malformed.json'), JSON.stringify({ messages: 'not-array' }));
    expect(resumeSession('malformed')).toBeNull();
  });

  it('不存在的会话 → null', () => {
    expect(resumeSession('nosuch-session')).toBeNull();
  });

  it('refreshProject 后按新 cwd 计算 autosave 归属', () => {
    refreshProject(); // cwd 未变 → PROJECT_ROOT 不变
    const cur = listSessions(10).filter(s => s.is_current);
    expect(cur.length).toBeGreaterThan(0); // 本项目的 autosave 正确标记
  });
});

describe('rebuildCommitted（历史 → UI 重建）', () => {
  it('thinking/text/tool_use/tool_result 各就各位', () => {
    const msgs = sampleMessages();
    const items = rebuildCommitted(msgs);
    const kinds = items.map(i => i.kind);
    expect(kinds).toContain('thinking_line');
    expect(kinds).toContain('assistant_line');
    expect(kinds).toContain('tool_result');
    // 工具轮后用户追加文本不丢（appendUserMessage 角色合并场景）
    const appended = items.find(i => i.kind === 'user' && String((i as { text: string }).text).includes('追加输入'));
    expect(appended).toBeDefined();
    // 多行 text 按 \n 拆 assistant_line
    const multi: MessageParam[] = [{ role: 'assistant', content: [{ type: 'text', text: '行一\n行二' }] }];
    expect(rebuildCommitted(multi).filter(i => i.kind === 'assistant_line')).toHaveLength(2);
  });

  it('纯图片 user 消息 → [图片] 占位', () => {
    const items = rebuildCommitted([{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }] }]);
    expect((items[0] as { text: string }).text).toBe('[图片]');
  });

  it('字符串 content 正常文本化', () => {
    const items = rebuildCommitted([{ role: 'user', content: '纯文本消息' }]);
    expect((items[0] as { text: string }).text).toBe('纯文本消息');
  });
});

describe('listSessions', () => {
  it('按时间倒序，非 JSON 文件跳过', () => {
    writeFileSync(path.join(SESSION_DIR, 'garbage.txt'), 'not json session');
    const list = listSessions(50);
    expect(list.every(s => s.filename.endsWith('.json'))).toBe(true);
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].timestamp >= list[i].timestamp).toBe(true);
    }
  });
});
