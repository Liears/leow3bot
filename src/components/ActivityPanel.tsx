import React, { useState, useEffect } from 'react';
import { Box, Text, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import { useStore } from '../store.js';
import { ACCENT } from '../config.js';

function fmt(sec: number): string {
  return sec >= 60 ? `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s` : `${sec}s`;
}

/** 显示宽度（CJK 等宽字符按 2 列计）——终端列宽对齐用 */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0xff ? 2 : 1;
  return w;
}

/** 按显示宽度截断（尾部加省略号）——防长行折行错位 */
function clipDisplay(s: string, maxCols: number): string {
  if (displayWidth(s) <= maxCols) return s;
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = ch.charCodeAt(0) > 0xff ? 2 : 1;
    if (w + cw > maxCols - 1) return out + '…';
    out += ch;
    w += cw;
  }
  return out;
}

// 运行时活动面板（动态区，不进 scrollback）：
//   普通工具打点行——executor 登记每个执行中工具，≥1s 才显示（快工具毫秒级完成，防闪烁）
//   子代理行——runner 维护（轮数 + 最近活动），即刻显示（慢任务需要即时可见）
// 行间留空行、整行按终端宽度截断（CJK 双宽对齐）防折行错位；
// 耗时每秒刷新（有行时挂 1s tick）；结束即移除，留档的只有 ⎿ 结果行。
export default function ActivityPanel() {
  const s = useStore();
  const [, setTick] = useState(0);
  const { stdout } = useStdout();
  const cols = (stdout?.columns ?? 100) - 4; // 预留 spinner 与边距
  const has = s.runningTools.length > 0 || s.subagents.length > 0;
  useEffect(() => {
    if (!has) return;
    const t = setInterval(() => setTick(x => x + 1), 1000); // 每秒刷新耗时打点
    return () => clearInterval(t);
  }, [has]);
  if (!has) return null;
  const now = Date.now();
  let rowIdx = 0;
  const row = (key: string, text: string) => (
    <Box key={key} gap={1} marginTop={rowIdx++ > 0 ? 1 : 0}>
      <Text color={ACCENT}><Spinner type="dots" /></Text>
      <Text dimColor>{clipDisplay(text, cols - 2)}</Text>
    </Box>
  );
  return (
    <Box flexDirection="column" marginTop={1}>
      {s.runningTools
        .filter(x => now - x.startedAt >= 1000)
        .map(x => row(`t${x.key}`, `${x.name} · ${x.summary} · ${fmt(Math.round((now - x.startedAt) / 1000))}`))}
      {s.subagents.map(x => {
        const elapsed = Math.max(0, Math.round((now - x.startedAt) / 1000));
        return row(x.key, `${x.name} · ${x.desc.replace(/\s+/g, ' ')} · ${x.rounds} 轮 · ${x.activity} · ${fmt(elapsed)}`);
      })}
    </Box>
  );
}
