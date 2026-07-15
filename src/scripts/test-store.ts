// store 层测试：验证流式 appendText 按 \n 拆行 + 代码块 ``` 状态机（mdInCode 跨行 + code 标记）。
import { appendText, flushText, resetMarkdown, getState } from '../store.js';

resetMarkdown();
appendText('# Title\n');
appendText('text **bold**\n');
appendText('```js\n');
appendText('const x = 1\n');
appendText('```\n');
appendText('after code');
flushText();

const lines = getState().committed
  .filter(i => i.kind === 'assistant_line')
  .map(i => ({ text: (i as { text: string }).text, code: (i as { code?: boolean }).code ?? false }));

for (const l of lines) console.log(`  [${l.code ? 'code' : 'md '}] ${JSON.stringify(l.text)}`);

const ok =
  lines.length === 6 &&
  lines[0].text === '# Title' && !lines[0].code &&
  lines[1].text === 'text **bold**' && !lines[1].code &&
  lines[2].text === '```js' && !lines[2].code &&   // 围栏边界不计 code
  lines[3].text === 'const x = 1' && lines[3].code &&  // 代码块内 → code=true
  lines[4].text === '```' && !lines[4].code &&      // 结束围栏
  lines[5].text === 'after code' && !lines[5].code;  // 代码块外

console.log(`\n${ok ? '✓ store 拆行 + 代码块状态机 OK' : '✗ store 逻辑异常'}`);
if (!ok) process.exit(1);
