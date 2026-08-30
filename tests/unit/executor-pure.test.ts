// Executor 纯函数单测（executor.ts）：分批 / 入参摘要 / 结果块组装（各类型
// tool_result 的 Anthropic 契约形态）/ 结果消息冲刷。执行侧（权限、真工具）见
// integration 层。
import { describe, it, expect } from 'vitest';
import { partitionToolCalls, summarizeToolInput, buildToolResultBlock, flushToolResults } from '../../src/executor.js';
import type { ToolDef } from '../../src/tools.js';
import type { MessageParam, ToolResultBlock } from '../../src/types.js';

const def = (safe: boolean): ToolDef => ({
  function: () => 'x',
  concurrencySafe: safe,
  schema: { name: 'x', description: '', input_schema: { type: 'object', properties: {}, required: [] } },
});

describe('partitionToolCalls', () => {
  const registry = { read: def(true), bash: def(false), view: def(true) };
  const tc = (name: string) => ({ id: name, name, input: {} });

  it('相邻 safe 合并同批，unsafe 单独成批', () => {
    const batches = partitionToolCalls([tc('read'), tc('view'), tc('bash'), tc('read')], registry);
    expect(batches.map(b => [b.safe, b.calls.length])).toEqual([
      [true, 2],   // read+view 相邻 safe 合并
      [false, 1],  // bash
      [true, 1],   // read（与前面被 bash 隔开，新批）
    ]);
  });

  it('未知工具（registry 无定义）按 unsafe 处理', () => {
    const batches = partitionToolCalls([tc('nosuch')], registry);
    expect(batches[0].safe).toBe(false);
  });
});

describe('summarizeToolInput', () => {
  it('按优先级取代表参数', () => {
    expect(summarizeToolInput({ name: 'bash', input: { command: 'ls -la', path: '/x' } })).toBe('ls -la');
    expect(summarizeToolInput({ name: 'read', input: { path: '/a/b/c.ts' } })).toBe('/a/b/c.ts');
    expect(summarizeToolInput({ name: 'web_search', input: { query: '智谱 GLM' } })).toBe('智谱 GLM');
  });
  it('长参数截断（57 字符 + …）', () => {
    const s = summarizeToolInput({ name: 'bash', input: { command: 'x'.repeat(100) } });
    expect(s.length).toBe(58); // slice(0,57) + 省略号
    expect(s.endsWith('…')).toBe(true);
  });
  it('空白/无可代表参数 → 空串', () => {
    expect(summarizeToolInput({ name: 'x', input: { command: '   ' } })).toBe('');
    expect(summarizeToolInput({ name: 'x', input: {} })).toBe('');
  });
});

describe('buildToolResultBlock', () => {
  const tc = { id: 'toolu_1', name: 'bash', input: {} };

  it('bash → content 为输出文本', () => {
    const b = buildToolResultBlock(tc, { type: 'bash', command: 'ls', output: '文件列表' });
    expect(b).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1', content: '文件列表' });
  });

  it('image → 文件名双侧夹注（开闭标签式绑定）', () => {
    const b = buildToolResultBlock(tc, { type: 'image', path: '/tmp/shots/a.png', media_type: 'image/png', base64: 'QUJD', size: '100 → 90 bytes' });
    const content = b.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(3);
    expect(content[0].text).toContain('<img name="a.png">');
    expect(content[0].text).toContain('/tmp/shots/a.png');
    expect(content[1]).toMatchObject({ type: 'image', source: { media_type: 'image/png', data: 'QUJD' } });
    expect(content[2].text).toContain('</img name="a.png">');
  });

  it('error → is_error: true', () => {
    const b = buildToolResultBlock(tc, { type: 'error', message: '出错了' });
    expect(b).toMatchObject({ tool_use_id: 'toolu_1', content: '出错了', is_error: true });
  });

  it('text 超长 → 中间截断 + 完整长度提示', () => {
    const b = buildToolResultBlock(tc, { type: 'text', content: 'y'.repeat(20000) });
    const c = String(b.content);
    expect(c).toContain('中间省略');
    expect(c).toContain('完整内容共 20000 字符');
  });

  it('web_search 有结果 → 结构化列表 + 引用来源要求', () => {
    const b = buildToolResultBlock({ id: 'w1', name: 'web_search', input: {} }, {
      type: 'web_search', query: 'glm', engine: 'search_std',
      results: [{ title: '智谱官网', link: 'https://z.ai', content: '摘要内容', media: 'z.ai' }],
    });
    const c = String(b.content);
    expect(c).toContain('🔍 网络搜索结果');
    expect(c).toContain('[1] 智谱官网');
    expect(c).toContain('https://z.ai');
    expect(c).toContain('用 markdown 链接引用');
  });

  it('web_search 零结果 → output 原样', () => {
    const b = buildToolResultBlock({ id: 'w2', name: 'web_search', input: {} }, {
      type: 'web_search', output: '搜索无结果', query: 'q', engine: 'e', results: [],
    });
    expect(b.content).toBe('搜索无结果');
  });

  it('task（子代理）→ report 进正文', () => {
    const b = buildToolResultBlock({ id: 's1', name: 'subagent', input: {} }, {
      type: 'task', output: '完成：概览', report: '[子代理 explore · 完成]\n\n报告', agent: 'explore',
    });
    expect(b.content).toBe('[子代理 explore · 完成]\n\n报告');
  });

  it('web_fetch → content 全文透传', () => {
    const b = buildToolResultBlock({ id: 'f1', name: 'web_fetch', input: {} }, { type: 'web_fetch', content: '# 正文', output: '已读取', url: 'https://x' });
    expect(b.content).toBe('# 正文');
  });

  it('未知形态 → String(result) 兜底', () => {
    const b = buildToolResultBlock(tc, 'plain-string');
    expect(b.content).toBe('plain-string');
  });
});

describe('flushToolResults', () => {
  it('全部结果合并为一条紧邻 user 消息（Anthropic 契约）', () => {
    const messages: MessageParam[] = [];
    const blocks: ToolResultBlock[] = [
      { type: 'tool_result', tool_use_id: 'u1', content: 'a' },
      { type: 'tool_result', tool_use_id: 'u2', content: 'b' },
    ];
    flushToolResults(blocks, messages);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(blocksOf(messages[0])).toHaveLength(2);
  });

  it('空数组 no-op', () => {
    const messages: MessageParam[] = [];
    flushToolResults([], messages);
    expect(messages).toHaveLength(0);
  });
});

function blocksOf(m: MessageParam): unknown[] {
  return Array.isArray(m.content) ? m.content : [];
}
