// store 拆行状态机单测（迁移自 src/scripts/test-store.ts，断言语义不变）：
// appendText 按 \n 拆完整行原子 commit + 代码块 ``` 围栏跨行跟踪（mdInCode）。
import { describe, it, expect } from 'vitest';
import { appendText, flushText, resetMarkdown, getState, setPhase } from '../../src/store.js';

function assistantLines(): Array<{ text: string; code: boolean }> {
  return getState().committed
    .filter(i => i.kind === 'assistant_line')
    .map(i => ({ text: (i as { text: string }).text, code: (i as { code?: boolean }).code ?? false }));
}

// store 是模块级单例（vitest 按文件隔离，文件内需自行重置——对齐 test-app.tsx 先例）
function resetCommitted(): void {
  const committed = getState().committed;
  committed.splice(0, committed.length);
}

describe('store 拆行 + 代码块状态机', () => {
  it('完整行逐条 commit，围栏边界不计 code，块内行 code=true', () => {
    setPhase('idle');
    resetCommitted();
    resetMarkdown();
    appendText('# Title\n');
    appendText('text **bold**\n');
    appendText('```js\n');
    appendText('const x = 1\n');
    appendText('```\n');
    appendText('after code');
    flushText();

    const lines = assistantLines();
    expect(lines.map(l => [l.text, l.code])).toEqual([
      ['# Title', false],
      ['text **bold**', false],
      ['```js', false],        // 围栏边界不计 code
      ['const x = 1', true],   // 代码块内 → code=true
      ['```', false],          // 结束围栏
      ['after code', false],   // 代码块外
    ]);
  });

  it('同帧多行（单次 append 含多个 \\n）原子 commit', () => {
    setPhase('idle');
    resetCommitted();
    resetMarkdown();
    appendText('a\nb\nc\n');
    flushText();
    expect(assistantLines().map(l => l.text)).toEqual(['a', 'b', 'c']);
    // 未完成段留动态区，不进 committed
    expect(getState().streamingText).toBe('');
  });

  it('flushText 把未完成段收为最后一行', () => {
    setPhase('idle');
    resetCommitted();
    resetMarkdown();
    appendText('partial');
    expect(assistantLines()).toHaveLength(0); // 无 \n → 尚未 commit
    flushText();
    expect(assistantLines().map(l => l.text)).toEqual(['partial']);
    expect(getState().streamingText).toBe('');
  });
});
