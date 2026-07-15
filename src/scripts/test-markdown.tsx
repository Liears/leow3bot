// 非交互 markdown 渲染测试：验证行内/标题/列表/代码块/引用 各语法渲染正确 + 样式码存在。
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { renderMarkdownLine } from '../lib/markdown.js';

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

let pass = 0;
let fail = 0;
for (const c of cases) {
  const { node } = renderMarkdownLine(c.text, c.inCode);
  const out = render(node).lastFrame() ?? '';
  const text = stripAnsi(out);
  const ok = text.includes(c.expect);
  console.log(`${ok ? '✓' : '✗'} [${c.inCode ? 'code' : 'md '}] ${JSON.stringify(c.text)} => ${JSON.stringify(text)}`);
  if (ok) pass++; else fail++;
}

// 样式码存在性（bold=反显/加粗，code=颜色）
const hasBold = (render(renderMarkdownLine('**b**', false).node).lastFrame() ?? '').includes('\x1b[1m');
const codeOut = render(renderMarkdownLine('`c`', false).node).lastFrame() ?? '';
const hasColor = codeOut !== stripAnsi(codeOut) && codeOut.length > 0;
console.log(`${hasBold ? '✓' : '✗'} **bold** 含加粗 ANSI`);
console.log(`${hasColor ? '✓' : '✗'} \`code\` 含颜色 ANSI`);

const total = cases.length + 2;
const passed = pass + (hasBold ? 1 : 0) + (hasColor ? 1 : 0);
console.log(`\n=== ${passed}/${total} 通过，${total - passed} 失败 ===`);
if (passed < total) process.exit(1);
