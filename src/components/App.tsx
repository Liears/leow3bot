import React from 'react';
import { Box, Text, Static, useInput, useApp } from 'ink';
import Spinner from 'ink-spinner';
import { useStore } from '../store.js';
import { SYM_THINK, ACCENT } from '../config.js';
import MessageList from './MessageList.js';
import Input from './Input.js';
import StatusBar from './StatusBar.js';
import { renderInline } from '../lib/markdown.js';
import { handleSubmit, abortRef } from '../agent.js';

export default function App() {
  const s = useStore();
  const { exit } = useApp();

  // ESC 中断流式（全局监听，任何 phase 都生效）
  useInput((_input, key) => {
    if (key.escape && abortRef.current) {
      abortRef.current.abort();
    }
  });

  const showInput = s.phase === 'idle' || s.phase === 'ask_pending';

  return (
    <Box flexDirection="column">
      {/* 已完成消息进原生 scrollback（只增） */}
      <Static items={s.committed}>
        {(item, i) => <MessageList key={i} item={item} />}
      </Static>

      {/* 动态区：流式时只显示生成指示（不渲染未完成段，避免标准 ink 动态区残留）。
          完整行逐行 commit 进 scrollback，markdown 渲染闭合后的整行。 */}
      {s.streamingThinking ? (
        <ThinkingWindow text={s.streamingThinking} />
      ) : (s.phase === 'thinking' || s.phase === 'streaming') ? (
        <Box gap={1}>
          <Text color={ACCENT}><Spinner type="dots" /></Text>
          <Text dimColor italic>{s.phase === 'thinking' ? `${SYM_THINK} thinking…` : '生成中…'}</Text>
        </Box>
      ) : null}

      {s.error ? (
        <Box><Text color="red">{s.error}</Text></Box>
      ) : null}

      {showInput ? (
        <Input
          promptLabel={s.phase === 'ask_pending' ? '❓' : undefined}
          onSubmit={(t, imgs) => handleSubmit(t, imgs, exit)}
        />
      ) : null}

      <StatusBar />
    </Box>
  );
}

// 思考窗口：固定 4 行（不足补空行），高度恒定避免 ink 动态区擦不净导致 spinner 残留。
function ThinkingWindow({ text }: { text: string }) {
  const lines = text.split('\n').slice(-4);
  const padded = [...lines, ...Array(Math.max(0, 4 - lines.length)).fill('')];
  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text color={ACCENT}><Spinner type="dots" /></Text>
        <Text dimColor italic>{SYM_THINK} thinking…</Text>
      </Box>
      <Box flexDirection="column">
        {padded.map((l, i) => (
          <Text key={i} dimColor italic>{l ? renderInline(l) : ' '}</Text>
        ))}
      </Box>
    </Box>
  );
}
