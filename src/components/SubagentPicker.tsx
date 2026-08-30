import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { ACCENT, MODEL, getSubagentModel, applyRuntimeConfig } from '../config.js';
import { getClient } from '../llm.js';
import { setPhase, commit } from '../store.js';

interface ModelEntry { id: string; at: string }

// 子代理模型选择器（/subagent 进入）：↑↓ 选择 · Enter 切换 · Esc/q 取消。
// 首项「跟随主模型」= 默认继承（清空 subagentModel）；其余来自端点 /v1/models。
// 选择即持久化（applyRuntimeConfig subagentModel）；运行中切换不影响已启动的子代理。
export default function SubagentPicker() {
  const [models, setModels] = useState<ModelEntry[] | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(0);

  const current = getSubagentModel(); // null = 跟随主模型

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const page = await getClient().models.list();
        const raw = (Array.isArray(page) ? page : ((page as { data?: unknown[] }).data ?? [])) as Array<{ id?: unknown; created_at?: unknown }>;
        const list = raw
          .map(m => ({ id: String(m?.id ?? ''), at: String(m?.created_at ?? '') }))
          .filter(m => m.id)
          .sort((a, b) => b.at.localeCompare(a.at));
        if (!alive) return;
        if (!list.length) setError('端点未返回任何模型');
        else {
          setModels(list);
          // 光标停在当前生效项（跟随主模型 → 首项；指定模型 → 对应项）
          const curIdx = current ? list.findIndex(m => m.id === current) : 0;
          setSelected(Math.max(0, curIdx));
        }
      } catch (e) {
        if (alive) setError(`模型列表获取失败: ${(e as Error).message}`);
      }
    })();
    return () => { alive = false; };
  }, []);

  useInput((input, key) => {
    const total = (models?.length ?? 0) + 1; // + 首项「跟随主模型」
    if (key.upArrow) setSelected(i => Math.max(0, i - 1));
    else if (key.downArrow) setSelected(i => Math.min(total - 1, i + 1));
    else if (key.escape || input === 'q') {
      setPhase('idle');
    } else if (key.return) {
      if (error || !models) { setPhase('idle'); return; }
      const pick = selected === 0 ? null : models[selected - 1]?.id ?? null;
      const persisted = applyRuntimeConfig({ subagentModel: pick }); // 运行时生效 + 写回 config
      commit({
        kind: 'system', tone: 'ok',
        text: pick
          ? `✓ 子代理模型已设置: ${pick}${persisted ? '' : '（⚠️ 写入配置失败，仅本次会话生效）'}（agent 定义自带 model 的仍优先）`
          : `✓ 子代理模型已恢复跟随主模型（${MODEL}）${persisted ? '' : '（⚠️ 写入配置失败）'}`,
      });
      setPhase('idle');
    }
  });

  if (error) {
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color="red">{error}</Text>
        <Text dimColor>按 Enter 返回（子代理模型仍为默认：跟随主模型）</Text>
      </Box>
    );
  }
  if (!models) {
    return (
      <Box marginTop={1}>
        <Text dimColor>正在获取模型列表…</Text>
      </Box>
    );
  }

  // 窗口化（对齐 ModelPicker）：只渲染选中附近若干行，防长列表闪烁
  const total = models.length + 1;
  const WINDOW = 9;
  const half = Math.floor((WINDOW - 1) / 2);
  const start = Math.max(0, Math.min(selected - half, Math.max(0, total - WINDOW)));

  const row = (idx: number, label: string, tag: string) => (
    <Box key={idx}>
      <Text color={idx === selected ? ACCENT : undefined} bold={idx === selected}>
        {idx === selected ? '▶ ' : '  '}{label}
      </Text>
      <Text dimColor> — {tag}</Text>
    </Box>
  );

  const rows: React.ReactNode[] = [];
  for (let idx = start; idx < Math.min(start + WINDOW, total); idx++) {
    if (idx === 0) rows.push(row(0, current ? '跟随主模型' : '● 跟随主模型', `默认 · 即 ${MODEL}${current ? '' : ' · 当前'}`));
    else {
      const m = models[idx - 1];
      rows.push(row(idx, m.id === current ? `● ${m.id}` : m.id, m.id === current ? '当前' : ''));
    }
  }

  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold>子代理模型</Text>
      <Text dimColor>↑↓ 选择 · Enter 确认 · Esc/q 取消 · 共 {total} 项（默认继承主模型）</Text>
      <Box flexDirection="column" marginTop={1}>
        {start > 0 ? <Text dimColor>  ↑ 更多…</Text> : null}
        {rows}
        {start + WINDOW < total ? <Text dimColor>  ↓ 更多…</Text> : null}
      </Box>
    </Box>
  );
}
