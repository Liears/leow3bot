// markdown 行渲染单测（迁移自 src/scripts/test-markdown.tsx，断言语义不变）：
// 行内/标题/列表/代码块/引用各语法渲染正确 + 样式码存在。
process.env.FORCE_COLOR = '1';

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { renderMarkdownLine } from '../../src/lib/markdown.js';

const cases: { text: string; inCode: boolean; expect: string }[] = [
  { text: '**bold** and normal', inCode: false, expect: 'bold and normal' },
  { text: 'inline `code` here', inCode: false, expect: 'inline code here' },
  { text: '# Heading', inCode: false, expect: 'Heading' },
  { text: '## Sub', inCode: false, expect: 'Sub' },
  { text: '- item one', inCode: false, expect: '• item one' },
  { text: '* star item', inCode: false, expect: '• star item' },
  { text: '1. first', inCode: false, expect: '1. first' },
  { text: '> quoted', inCode: false, expect: '│ quoted' },
  { text: '[link text](http://x)', inCode: false, expect: 'link text' },
  { text: 'const x = 1', inCode: true, expect: 'const x = 1' }, // 代码块内：原样 dimColor
  { text: 'plain text', inCode: false, expect: 'plain text' },
];

describe('renderMarkdownLine', () => {
  for (const c of cases) {
    it(`[${c.inCode ? 'code' : 'md '}] ${JSON.stringify(c.text)} → ${JSON.stringify(c.expect)}`, () => {
      const node = renderMarkdownLine(c.text, c.inCode);
      const out = render(node).lastFrame() ?? '';
      expect(stripAnsi(out)).toContain(c.expect);
    });
  }

  it('**bold** 含加粗 ANSI', () => {
    const out = render(renderMarkdownLine('**b**', false)).lastFrame() ?? '';
    expect(out).toContain('\x1b[1m');
  });

  it('`code` 含颜色 ANSI', () => {
    const out = render(renderMarkdownLine('`c`', false)).lastFrame() ?? '';
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toBe(stripAnsi(out)); // 有转义序列 = 有颜色
  });
});
