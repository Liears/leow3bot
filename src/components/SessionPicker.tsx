import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { ACCENT, getSkillDirs, MODEL } from '../config.js';
import { listSessions, resumeSession, activateResume, setSessionTitle } from '../session.js';
import { commit, setPhase, setMeta } from '../store.js';
import { loadSkills, SKILLS_REGISTRY } from '../skills.js';
import { TOOLS_REGISTRY } from '../tools.js';
import { homedir } from 'node:os';

// 交互式会话选择器（--resume 不带值 / 带值时直接恢复）：↑↓ 选择 · Enter 恢复 · Esc/q 新会话
export default function SessionPicker() {
  const [selected, setSelected] = useState(0);
  const sessions = useMemo(() => listSessions(50), []);

  useInput((input, key) => {
    if (key.upArrow) setSelected(i => Math.max(0, i - 1));
    else if (key.downArrow) setSelected(i => Math.min(sessions.length - 1, i + 1));
    else if (key.return) {
      const s = sessions[selected];
      if (s) {
        const resumed = resumeSession(s.filename);
        if (resumed) {
          // 与启动 --resume 一致：chdir 到会话所属项目 + 消息/历史恢复 + 刷新 meta 与项目级 skill
          const prevCwd = process.cwd();
          setSessionTitle(resumed.name); // 主题更新基准 = 会话文件里的主题
          activateResume(resumed);
          if (process.cwd() !== prevCwd) {
            loadSkills(getSkillDirs()); // 项目级 skill 按新目录重扫
            setMeta({
              model: MODEL,
              nTools: Object.keys(TOOLS_REGISTRY).length,
              nSkills: SKILLS_REGISTRY.size,
              cwd: process.cwd(),
            });
          }
          commit({
            kind: 'system', tone: 'ok',
            text: `✓ 已恢复会话 ${s.filename}（${resumed.messages.length} 条消息）` +
              (process.cwd() !== prevCwd ? `，工作目录已切换: ${process.cwd()}` : ''),
          });
        }
      }
      setPhase('idle');
    } else if (key.escape || input === 'q') {
      setPhase('idle'); // 不恢复，开始新会话
    }
  });

  if (!sessions.length) {
    return (
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>没有已保存的会话</Text>
        <Text dimColor>按 Enter 开始新会话</Text>
      </Box>
    );
  }

  const WINDOW = 9;
  const half = Math.floor((WINDOW - 1) / 2);
  const start = Math.max(0, Math.min(selected - half, Math.max(0, sessions.length - WINDOW)));
  const visible = sessions.slice(start, start + WINDOW);
  const home = homedir();
  const short = (p: string) => (p && p.startsWith(home) ? '~' + p.slice(home.length) : p || '?');

  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold>恢复会话（--resume）</Text>
      <Text dimColor>↑↓ 选择 · Enter 恢复 · Esc/q 新会话 · 共 {sessions.length} 个</Text>
      <Box flexDirection="column" marginTop={1}>
        {start > 0 ? <Text dimColor>  ↑ 更多…</Text> : null}
        {visible.map((s, i) => {
          const realIdx = start + i;
          const name = s.name.length > 30 ? s.name.slice(0, 29) + '…' : s.name;
          const proj = s.is_current_project ? '' : ` [${short(s.projectRoot)}]`;
          const cur = s.is_current ? ' (自动保存)' : '';
          return (
            <Box key={s.filename}>
              <Text color={realIdx === selected ? ACCENT : undefined} bold={realIdx === selected}>
                {realIdx === selected ? '▶ ' : '  '}{s.filename.replace(/\.json$/, '')}{cur}
              </Text>
              <Text dimColor> — {name} ({s.message_count} 条){proj}</Text>
            </Box>
          );
        })}
        {start + WINDOW < sessions.length ? <Text dimColor>  ↓ 更多…</Text> : null}
      </Box>
    </Box>
  );
}
