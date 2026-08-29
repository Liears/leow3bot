import React from 'react';
import { Box, Text, Static, useInput, useApp, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import { useStore, setPhase, setMeta, commit } from '../store.js';
import { SYM_THINK, ACCENT } from '../config.js';
import MessageList from './MessageList.js';
import Input from './Input.js';
import StatusBar from './StatusBar.js';
import SkillsPicker from './SkillsPicker.js';
import SessionPicker from './SessionPicker.js';
import ModelPicker from './ModelPicker.js';
import { handleSubmit, abortRef, buildSystem, setSystem, probeWebSearchAvailability } from '../agent.js';
import Onboarding from './Onboarding.js';
import { applyRuntimeConfig, API_BASE_URL } from '../config.js';
import { TOOLS_REGISTRY } from '../tools.js';
import { SKILLS_REGISTRY } from '../skills.js';

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
      {/* 已完成消息进原生 scrollback（只增）。Static 按数组长度增量渲染，
          故 items 必须用 committed 原样（每行一条，长度单调递增）——任何
          合并/过滤都会吞输出。行距统一见 MessageList.lineMarginTop。 */}
      <Static items={s.committed}>
        {(item, i) => <MessageList key={i} item={item} />}
      </Static>

      {/* 动态区：内容紧跟 Static（短对话跟在后、长对话由 scrollback 贴底）。
          思考逐行进 scrollback，动态区只剩 spinner/Input，高度小且稳定。 */}
      <Box flexDirection="column">
        {/* 整个回合（thinking/streaming/tool_running）Spinner 行常驻占位——
            高度恒定防状态栏跳动：若 tool_running 时此行消失，工具循环每轮
            动态区高度 ±1 抖动，底部 StatusBar 会上下跳（agent.ts 设的执行
            spinner 原意如此，此处条件曾漏掉 tool_running） */}
        {(s.phase === 'thinking' || s.phase === 'streaming' || s.phase === 'tool_running') ? (
          <Box gap={1} marginTop={1}>
            <Text color={ACCENT}><Spinner type="dots" /></Text>
            <Text dimColor italic>
              {s.phase === 'thinking' ? `${SYM_THINK} thinking…` : s.phase === 'tool_running' ? '⏺ 执行工具…' : '生成中…'}
            </Text>
          </Box>
        ) : null}

        {s.error ? (
          <Box marginTop={1}><Text color="red">{s.error}</Text></Box>
        ) : null}

        {showInput ? (
          <Box flexDirection="column" marginTop={1}>
            <Separator />
            <Input
              promptLabel={s.phase === 'ask_pending' ? '❓' : s.phase === 'confirm_pending' ? '⚠️' : undefined}
              onSubmit={(t, imgs) => handleSubmit(t, imgs, exit)}
            />
            <Separator />
          </Box>
        ) : null}

        {s.phase === 'onboarding' ? (
          <Onboarding
            onDone={({ apiBaseUrl, apiKey, model, contextWindow }) => {
              // 四步产物一次性落盘：端点与当前生效值相同则不写（极简凭据存储，
              // 且与生效值比较——code-review F4）；model/contextWindow 是用户的
              // 明确选择，总是写入。onboarding 已含选模型，不再跑 autoDetectModel。
              const needUrl = apiBaseUrl !== API_BASE_URL;
              const persisted = applyRuntimeConfig({ apiKey, ...(needUrl ? { apiBaseUrl } : {}), model, contextWindow });
              setMeta({ model, nTools: Object.keys(TOOLS_REGISTRY).length, nSkills: SKILLS_REGISTRY.size, cwd: process.cwd() });
              commit(persisted
                ? { kind: 'system', tone: 'ok', text: `✓ 配置已写入 ~/.leow3bot/config.json（模型 ${model} · 上下文 ${contextWindow.toLocaleString()}）—— 开始使用吧（/help 查看命令）` }
                : { kind: 'system', tone: 'warn', text: '⚠️ 配置已生效但写入 ~/.leow3bot/config.json 失败（目录不可写？）——本次会话可用，重启后需重新配置' });
              setPhase('idle');
              void probeWebSearchAvailability(); // key 就位后补探测（启动时因空 key 跳过）
            }}
          />
        ) : null}

        {s.phase === 'skills_picker' ? (
          <SkillsPicker onDone={() => { setSystem(buildSystem()); setPhase('idle'); }} />
        ) : null}

        {s.phase === 'model_picker' ? (
          <ModelPicker />
        ) : null}

        {s.phase === 'session_picker' ? (
          <SessionPicker />
        ) : null}

        <StatusBar />
      </Box>
    </Box>
  );
}
