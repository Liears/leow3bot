// 演示当前 markdown 渲染效果：模拟一段助手回复，渲染整段 markdown。
import { render } from 'ink-testing-library';
import { commit, setMeta, resetMarkdown, appendText, flushText } from '../store.js';
import App from '../components/App.js';

commit({ kind: 'user', text: '介绍一下这个项目' });
resetMarkdown();
appendText(
  [
    '# MiniClaude',
    '',
    '一个 **CLI AI agent**，用 `ink` 渲染，支持 [链接](https://example.com)。',
    '',
    '## 主要功能',
    '',
    '- 流式逐字输出',
    '- markdown 实时渲染',
    '- 状态栏不闪烁',
    '',
    '```ts',
    'const agent = createAgent();',
    'agent.run();',
    '```',
    '',
    '> 注意：这是一个引用示例。',
    '',
    '1. 第一步：安装依赖',
    '2. 第二步：运行 npm start',
  ].join('\n'),
);
flushText();
setMeta({ model: 'qwen3.7-plus', nTools: 6, nSkills: 0, cwd: '~/code/MiniClaude' });

const { lastFrame, unmount } = render(<App />);
process.stdout.write(lastFrame() + '\n');
unmount();
process.exit(0);
