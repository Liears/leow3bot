// App 组件集成测试（迁移自 src/scripts/test-app.tsx，断言语义不变）：
// welcome（logo+名称）与状态栏渲染不崩；流式增量渲染完整性回归
// （Static 按数组长度增量渲染，曾因分组合并导致多行只显示首行）。
process.env.FORCE_COLOR = '1';

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { commit, setMeta, appendText, flushText, resetMarkdown, setPhase, getState } from '../../src/store.js';
import { getWelcomeItems } from '../../src/commands.js';
import App from '../../src/components/App.js';
import { MODEL } from '../../src/config.js';

function resetCommitted(): void {
  const committed = getState().committed;
  committed.splice(0, committed.length);
}

describe('App 启动渲染（welcome + markdown + 状态栏）', () => {
  it('logo/名称/model/提示符渲染，markdown 语法消费', () => {
    setPhase('idle');
    resetCommitted();
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

    expect(out).toContain('Leow3Bot');
    expect(out).toContain(MODEL);
    expect(out).toContain('❯'); // 输入提示符
    // markdown 已渲染：字面语法被消费（# 标题→标题，** **→加粗，` `→代码）
    expect(out).not.toContain('# 标题');
    expect(out).not.toContain('**加粗**');
    expect(out).not.toContain('`代码`');
    expect(stripAnsi(out)).toContain('• 列表项');
  });
});

describe('流式增量渲染回归（多行只显示首行 bug）', () => {
  it('首帧完整渲染 + 增量行完整渲染', async () => {
    setPhase('idle');
    resetCommitted();
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

    expect(f1ok).toBe(true);
    expect(f2).toContain('第一行');
    expect(f2).toContain('第二行');
    expect(f2).toContain('第三行');
  });
});
