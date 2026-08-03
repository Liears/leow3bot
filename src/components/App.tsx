import React from 'react';
import { Box, Text, Static, useInput, useApp, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import { useStore, setPhase } from '../store.js';
import { SYM_THINK, ACCENT } from '../config.js';
import MessageList from './MessageList.js';
import Input from './Input.js';
import StatusBar from './StatusBar.js';
import SkillsPicker from './SkillsPicker.js';
import { handleSubmit, abortRef, buildSystem, setSystem } from '../agent.js';

// 输入区上下分隔线（复刻 CC 风格）
function Separator() {
  const { stdout } = useStdout();
  const w = stdout?.columns ?? 80;
  return <Text dimColor>{'─'.repeat(w)}</Text>;
}

export default function App() {
  const s = useStore();
  const { exit } = useApp();

  // ESC 中断流式（全局监听，任何 phase 都生效）
  useInput((_input, key) => {
    if (key.escape && abortRef.current) {
      abortRef.current.abort();
    }
  });

  const showInput = s.phase === 'idle' || s.phase === 'ask_pending' || s.phase === 'confirm_pending';

  return (
    <Box flexDirection="column">
      {/* 已完成消息进原生 scrollback（只增） */}
      <Static items={s.committed}>
        {(item, i) => <MessageList key={i} item={item} />}
      </Static>

      {/* 动态区：内容紧跟 Static（短对话跟在后、长对话由 scrollback 贴底）。
          思考逐行进 scrollback，动态区只剩 spinner/Input，高度小且稳定。 */}
      <Box flexDirection="column">
        {(s.phase === 'thinking' || s.phase === 'streaming') ? (
          <Box gap={1}>
            <Text color={ACCENT}><Spinner type="dots" /></Text>
            <Text dimColor italic>{s.phase === 'thinking' ? `${SYM_THINK} thinking…` : '生成中…'}</Text>
          </Box>
        ) : null}

        {s.error ? (
          <Box><Text color="red">{s.error}</Text></Box>
        ) : null}

        {showInput ? (
          <Box flexDirection="column">
            <Separator />
            <Input
              promptLabel={s.phase === 'ask_pending' ? '❓' : s.phase === 'confirm_pending' ? '⚠️' : undefined}
              onSubmit={(t, imgs) => handleSubmit(t, imgs, exit)}
            />
            <Separator />
          </Box>
        ) : null}

        {s.phase === 'skills_picker' ? (
          <SkillsPicker onDone={() => { setSystem(buildSystem()); setPhase('idle'); }} />
        ) : null}

        <StatusBar />
      </Box>
    </Box>
  );
}
