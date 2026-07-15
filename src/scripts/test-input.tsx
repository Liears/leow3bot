// 测试命令补全：render Input，输入 '/'，看补全列表是否出现。
import { render } from 'ink-testing-library';
import Input from '../components/Input.js';

const { stdin, lastFrame, unmount } = render(<Input onSubmit={() => {}} />);
stdin.write('/');
setTimeout(() => {
  const out = lastFrame() ?? '';
  console.log('--- 输入 "/" 后 Input 渲染 ---');
  console.log(JSON.stringify(out));
  const hasList = out.includes('help');
  console.log(hasList ? '✓ 补全列表显示' : '✗ 补全列表未显示');
  unmount();
  process.exit(hasList ? 0 : 1);
}, 300);
