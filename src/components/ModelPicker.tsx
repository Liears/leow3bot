import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { ACCENT, MODEL, getModelMaxTokens, applyRuntimeConfig } from '../config.js';
import { getClient } from '../llm.js';
import { setPhase, setMeta, commit, getState } from '../store.js';

interface ModelEntry { id: string; at: string }

// 交互式模型选择器（/model 无参进入）：↑↓ 选择 · Enter 切换 · Esc/q 取消。
// 列表来自端点 /v1/models（created_at 降序 = 最新在前），当前模型打标；
// 每项顺带显示该模型已学习的 max_tokens 上限（未撞过限的显示全局默认）。
// 切换即持久化（applyRuntimeConfig），max_tokens 经 modelLimits 按模型自动跟随。
export default function ModelPicker() {
  const [models, setModels] = useState<ModelEntry[] | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(0);

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
          setSelected(Math.max(0, list.findIndex(m => m.id === MODEL))); // 光标停在当前模型
        }
      } catch (e) {
        if (alive) setError(`模型列表获取失败: ${(e as Error).message}`);
      }
    })();
    return () => { alive = false; };
  }, []);

  useInput((input, key) => {
    if (key.upArrow) setSelected(i => Math.max(0, i - 1));
    else if (key.downArrow) setSelected(i => Math.min((models?.length ?? 1) - 1, i + 1));
    else if (key.escape || input === 'q') {
      setPhase('idle');
    } else if (key.return) {
      if (error || !models) { setPhase('idle'); return; }
      const pick = models[selected];
      if (!pick) { setPhase('idle'); return; }
      if (pick.id === MODEL) { setPhase('idle'); return; } // 选的就是当前 → 静默退出
      const persisted = applyRuntimeConfig({ model: pick.id }); // 运行时生效 + 写回 config
      const prev = getState().meta;
      setMeta({ model: pick.id, nTools: prev?.nTools ?? 0, nSkills: prev?.nSkills ?? 0, cwd: prev?.cwd ?? process.cwd() });
      commit({
        kind: 'system', tone: 'ok',
        text: `✓ 模型已切换: ${pick.id}${persisted ? '' : '（⚠️ 写入配置失败，仅本次会话生效）'} · max_tokens 上限 ${getModelMaxTokens(pick.id).toLocaleString()}`,
      });
      setPhase('idle');
    }
  });

  if (error) {
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color="red">{error}</Text>
        <Text dimColor>按 Enter 返回（仍可用 /model &lt;名称&gt; 直接切换）</Text>
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

  // 窗口化（对齐 SkillsPicker）：只渲染选中附近若干行，防长列表闪烁
  const WINDOW = 9;
  const half = Math.floor((WINDOW - 1) / 2);
  const start = Math.max(0, Math.min(selected - half, Math.max(0, models.length - WINDOW)));
  const visible = models.slice(start, start + WINDOW);

  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold>模型切换</Text>
      <Text dimColor>↑↓ 选择 · Enter 确认 · Esc/q 取消 · 共 {models.length} 个（新→旧）</Text>
      <Box flexDirection="column" marginTop={1}>
        {start > 0 ? <Text dimColor>  ↑ 更多…</Text> : null}
        {visible.map((m, i) => {
          const realIdx = start + i;
          const cur = m.id === MODEL;
          return (
            <Box key={m.id}>
              <Text color={realIdx === selected ? ACCENT : undefined} bold={realIdx === selected}>
                {realIdx === selected ? '▶ ' : '  '}{cur ? '● ' : '  '}{m.id}
              </Text>
              <Text dimColor> — 输出上限 {getModelMaxTokens(m.id).toLocaleString()}{cur ? ' · 当前' : ''}</Text>
            </Box>
          );
        })}
        {start + WINDOW < models.length ? <Text dimColor>  ↓ 更多…</Text> : null}
      </Box>
    </Box>
  );
}
