// 集成测试：模拟 main.tsx 启动流程，render <App/>，验证 welcome（logo+名称）和状态栏渲染、不崩。
// 第二部分：流式增量渲染完整性回归（Static 按数组长度增量渲染，曾因分组合并导致多行只显示首行）。
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { commit, setMeta, appendText, flushText, resetMarkdown, getState } from '../store.js';
import { getWelcomeItems } from '../commands.js';
import App from '../components/App.js';
import { MODEL } from '../config.js';

for (const item of getWelcomeItems()) commit(item);
setMeta({ model: MODEL, nTools: 8, nSkills: 0, cwd: '/Users/test/Leow3Bot' });

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

// —— 流式增量渲染回归：多行回复必须逐行完整渲染（曾因分组导致只显示首行）——
async function testStreamingIncremental(): Promise<boolean> {
  // 清掉前面测试的 committed 状态，从干净序列开始
  const committed = getState().committed;
  committed.splice(0, committed.length);
  resetMarkdown();
  commit({ kind: 'user', text: '流式测试' });
  commit({ kind: 'thinking_line', text: '思考一' });
  commit({ kind: 'thinking_line', text: '思考二' });
  appendText('第一行\n');
  appendText('第二行');
  flushText();

  const { lastFrame, unmount } = render(<App />);
  await new Promise(r => setTimeout(r, 30));
  const f1 = lastFrame() ?? '';
  const f1ok = f1.includes('第一行') && f1.includes('第二行') && f1.includes('思考一') && f1.includes('思考二');

  // 增量：追加第三行（Static 只渲染新增项）
  appendText('第三行\n');
  flushText();
  await new Promise(r => setTimeout(r, 30));
  const f2 = lastFrame() ?? '';
  unmount();

  const f2ok = f2.includes('第一行') && f2.includes('第二行') && f2.includes('第三行');
  console.log(`${f1ok ? '✓' : '✗'} 流式首帧完整渲染`);
  console.log(`${f2ok ? '✓' : '✗'} 流式增量行完整渲染（回归：多行只显示首行 bug）`);
  return f1ok && f2ok;
}

const hasName = out.includes('Leow3Bot');
const hasModel = out.includes(MODEL);
const hasPrompt = out.includes('❯'); // 输入提示符
// markdown 已渲染：字面语法被消费（# 标题→标题，** **→加粗，` `→代码）
const noLiteralHash = !out.includes('# 标题');
const noLiteralStar = !out.includes('**加粗**');
const noLiteralBack = !out.includes('`代码`');
const hasBullet = stripAnsi(out).includes('• 列表项');
const ok = hasName && hasModel && hasPrompt && noLiteralHash && noLiteralStar && noLiteralBack && hasBullet;
console.log(`\n${hasName ? '✓' : '✗'} 含名称 Leow3Bot`);
console.log(`${hasModel ? '✓' : '✗'} 状态栏含 model`);
console.log(`${hasPrompt ? '✓' : '✗'} 含输入提示符 ❯`);
console.log(`${noLiteralHash ? '✓' : '✗'} 标题 # 已渲染（无字面 #）`);
console.log(`${noLiteralStar ? '✓' : '✗'} **加粗** 已渲染（无字面 **）`);
console.log(`${noLiteralBack ? '✓' : '✗'} \`代码\` 已渲染（无字面反引号）`);
console.log(`${hasBullet ? '✓' : '✗'} 列表渲染为 •`);
const streamOk = await testStreamingIncremental();
console.log(`\n=== ${ok && streamOk ? '集成启动 + markdown 渲染 + 流式增量 OK' : '集成异常'} ===`);
if (!ok || !streamOk) process.exit(1);

