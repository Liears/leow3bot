// 集成测试：模拟 main.tsx 启动流程，render <App/>，验证 welcome（logo+名称）和状态栏渲染、不崩。
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { commit, setMeta } from '../store.js';
import { getWelcomeItems } from '../commands.js';
import App from '../components/App.js';

for (const item of getWelcomeItems()) commit(item);
setMeta({ model: 'qwen3.7-plus', nTools: 6, nSkills: 0, cwd: '/Users/test/MiniClaude' });

// 模拟一段流式 markdown 回复（assistant_line）
commit({ kind: 'assistant_line', text: '# 标题' });
commit({ kind: 'assistant_line', text: '这是 **加粗** 和 `代码` 混排' });
commit({ kind: 'assistant_line', text: '```js' });
commit({ kind: 'assistant_line', text: 'const x = 1', code: true });
commit({ kind: 'assistant_line', text: '```' });
commit({ kind: 'assistant_line', text: '- 列表项' });

const { lastFrame, unmount } = render(<App />);
const out = lastFrame() ?? '';
unmount();

console.log('--- App 渲染输出 ---');
console.log(out);
console.log('--- end ---');

const hasName = out.includes('MiniClaude');
const hasModel = out.includes('qwen3.7-plus');
const hasPrompt = out.includes('❯'); // 输入提示符
// markdown 已渲染：字面语法被消费（# 标题→标题，** **→加粗，` `→代码）
const noLiteralHash = !out.includes('# 标题');
const noLiteralStar = !out.includes('**加粗**');
const noLiteralBack = !out.includes('`代码`');
const hasBullet = stripAnsi(out).includes('• 列表项');
const ok = hasName && hasModel && hasPrompt && noLiteralHash && noLiteralStar && noLiteralBack && hasBullet;
console.log(`\n${hasName ? '✓' : '✗'} 含名称 MiniClaude`);
console.log(`${hasModel ? '✓' : '✗'} 状态栏含 model`);
console.log(`${hasPrompt ? '✓' : '✗'} 含输入提示符 ❯`);
console.log(`${noLiteralHash ? '✓' : '✗'} 标题 # 已渲染（无字面 #）`);
console.log(`${noLiteralStar ? '✓' : '✗'} **加粗** 已渲染（无字面 **）`);
console.log(`${noLiteralBack ? '✓' : '✗'} \`代码\` 已渲染（无字面反引号）`);
console.log(`${hasBullet ? '✓' : '✗'} 列表渲染为 •`);
console.log(`\n=== ${ok ? '集成启动 + markdown 渲染 OK' : '集成异常'} ===`);
if (!ok) process.exit(1);

