import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { ACCENT } from '../config.js';
import { listSkillsWithStatus, enableSkill, disableSkill } from '../skills.js';

// 交互式 skill 开关：↑↓ 移动光标 · Tab 切换启用/禁用 · Enter 完成 · Esc/q 退出
export default function SkillsPicker({ onDone }: { onDone: () => void }) {
  const [selected, setSelected] = useState(0);
  const [version, setVersion] = useState(0); // toggle 后强制重读状态
  const skills = useMemo(() => listSkillsWithStatus(), [version]);

  useInput((input, key) => {
    if (key.upArrow) setSelected(i => Math.max(0, i - 1));
    else if (key.downArrow) setSelected(i => Math.min(skills.length - 1, i + 1));
    else if (key.tab) {
      const s = skills[selected];
      if (s) {
        if (s.disabled) enableSkill(s.name);
        else disableSkill(s.name);
        setVersion(v => v + 1); // 状态变了，重渲染读新状态
      }
    } else if (key.return || key.escape || input === 'q') {
      onDone();
    }
  });

  if (!skills.length) {
    return (
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>没有加载任何 skill</Text>
        <Text dimColor>按 Enter 返回</Text>
      </Box>
    );
  }

  // 窗口化：只渲染选中附近若干行，降低动态区高度（避免 ink 重绘整个长列表导致闪烁）
  const WINDOW = 9;
  const half = Math.floor((WINDOW - 1) / 2);
  const start = Math.max(0, Math.min(selected - half, Math.max(0, skills.length - WINDOW)));
  const visible = skills.slice(start, start + WINDOW);

  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold>skills 开关</Text>
      <Text dimColor>↑↓ 选择 · Tab 启用/禁用 · Enter 完成 · 共 {skills.length} 个</Text>
      <Box flexDirection="column" marginTop={1}>
        {start > 0 ? <Text dimColor>  ↑ 更多…</Text> : null}
        {visible.map((s, i) => {
          const realIdx = start + i;
          // description 截断成一行，避免长描述换行导致 picker 高度暴涨 + ink 重绘跳动
          const desc = s.description.length > 38 ? s.description.slice(0, 37) + '…' : s.description;
          return (
            <Box key={s.name}>
              <Text color={realIdx === selected ? ACCENT : undefined} bold={realIdx === selected}>
                {realIdx === selected ? '▶ ' : '  '}{s.disabled ? '⛔' : '✅'} {s.name}
              </Text>
              <Text dimColor> — {desc}</Text>
            </Box>
          );
        })}
        {start + WINDOW < skills.length ? <Text dimColor>  ↓ 更多…</Text> : null}
      </Box>
    </Box>
  );
}
