// 消息压缩单测（compaction.ts）：媒体消息摘要化 / 旧工具结果压缩 /
// 轮入口图片驱逐 / 故障降级释放。全部操作传入的 messages 数组，纯逻辑。
import { describe, it, expect } from 'vitest';
import {
  compactMediaMessages, compactOldToolResults,
  evictPreviousTurnImages, evictOldImages, IMG_EVICTED_MARKER_TOOL, IMG_EVICTED_MARKER_PASTE,
} from '../../src/compaction.js';
import type { MessageParam, ContentBlock } from '../../src/types.js';

const img = (): ContentBlock => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } });

describe('compactMediaMessages', () => {
  it('含图 user 消息替换为文本摘要，返回压缩数', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'read /path/to/a.png 的结果' }] },
      { role: 'assistant', content: [{ type: 'text', text: '这张图展示了测试架构' }] },
      { role: 'user', content: [{ type: 'text', text: '看这张' }, img()] },
      { role: 'assistant', content: [{ type: 'text', text: '分析：图中有三个模块' }] },
    ];
    const n = compactMediaMessages(messages);
    expect(n).toBe(1);
    const replaced = messages[2];
    expect(typeof replaced.content).toBe('string');
    const text = replaced.content as string;
    expect(text).toContain('模型分析摘要');
    expect(text).toContain('图中有三个模块');
  });

  it('无图片消息不动', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: '纯文本' },
      { role: 'assistant', content: '回复' },
    ];
    expect(compactMediaMessages(messages)).toBe(0);
    expect(messages[0].content).toBe('纯文本');
  });

  it('无前序工具信息/后续分析时退化为占位文本', () => {
    const messages: MessageParam[] = [{ role: 'user', content: [img()] }];
    compactMediaMessages(messages);
    expect(messages[0].content).toBe('[已处理的媒体内容]');
  });
});

describe('compactOldToolResults', () => {
  const toolMsg = (id: string, text: string): MessageParam => ({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: text }],
  });

  it('只压缩超出 keepRecent 的旧结果，短内容不动', () => {
    const messages: MessageParam[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(toolMsg(`t${i}`, 'x'.repeat(500)));
      messages.push({ role: 'assistant', content: [{ type: 'text', text: `回复${i}` }] });
    }
    const n = compactOldToolResults(messages, 6);
    expect(n).toBe(2); // 8 - 6 = 2 条旧消息被压缩
    const first = messages[0].content as ContentBlock[];
    const last = messages[14].content as ContentBlock[];
    expect(String((first[0] as { content: unknown }).content)).toContain('[已压缩');
    expect(String((last[0] as { content: unknown }).content)).not.toContain('[已压缩');
  });

  it('已压缩过的内容不重复压缩（幂等守卫按真实写入标记匹配）', () => {
    const messages: MessageParam[] = [toolMsg('t1', 'y'.repeat(300) + ' [已压缩，原始内容共500字符]')];
    expect(compactOldToolResults(messages, 0)).toBe(0);
    // 守卫失效的后果回归：若重复压缩，前 150 字符会被再切一遍（长度骤减）
    const content = () => String(((messages[0].content as ContentBlock[])[0] as { content: unknown }).content);
    expect(content().length).toBeGreaterThan(300);
  });
});

describe('evictPreviousTurnImages（轮入口驱逐）', () => {
  it('历史顶层粘贴图驱逐、最后一条保留', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: [img()] },
      { role: 'assistant', content: [{ type: 'text', text: '看了' }] },
      { role: 'user', content: [img()] }, // 本轮输入，保留
    ];
    const n = evictPreviousTurnImages(messages);
    expect(n).toBe(1);
    const first = messages[0].content as ContentBlock[];
    expect(first[0]).toEqual({ type: 'text', text: IMG_EVICTED_MARKER_PASTE });
    const last = messages[2].content as ContentBlock[];
    expect(last[0].type).toBe('image'); // 本轮输入保留
  });

  it('tool_result 内嵌图即使最后一条也驱逐（错误回合残留场景）', () => {
    const messages: MessageParam[] = [{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a.png' }, img()] }],
    }];
    const n = evictPreviousTurnImages(messages);
    expect(n).toBe(1);
    const inner = ((messages[0].content as ContentBlock[])[0] as { content: ContentBlock[] }).content;
    expect(inner[1].type).toBe('text');
    expect((inner[1] as { text: string }).text).toContain(IMG_EVICTED_MARKER_TOOL);
    expect((inner[1] as { text: string }).text).toContain('重新 view');
  });
});

describe('evictOldImages（故障降级释放）', () => {
  const imgToolMsg = (id: string): MessageParam => ({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: [img()] }],
  });

  it('keepRecent 条之外驱逐，之内保留', () => {
    const messages: MessageParam[] = [
      imgToolMsg('t1'), { role: 'assistant', content: 'r1' },
      imgToolMsg('t2'), { role: 'assistant', content: 'r2' },
      imgToolMsg('t3'), { role: 'assistant', content: 'r3' },
    ];
    const n = evictOldImages(messages, 1);
    expect(n).toBe(2); // 3 条含图消息 keep 1 → 驱逐 2
    const b1 = (messages[0].content as ContentBlock[])[0] as { content: ContentBlock[] };
    expect(b1.content[0].type).toBe('text'); // 驱逐 → 占位
    const b3 = (messages[4].content as ContentBlock[])[0] as { content: ContentBlock[] };
    expect(b3.content[0].type).toBe('image'); // 最近保留
  });

  it('含图消息数 ≤ keepRecent 全保留', () => {
    const messages: MessageParam[] = [imgToolMsg('t1'), { role: 'assistant', content: 'r1' }];
    expect(evictOldImages(messages, 3)).toBe(0);
  });
});
