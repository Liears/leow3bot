import React, { useMemo } from 'react';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Box, Text } from 'ink';
import { useStore } from '../store.js';
import { CONTEXT_WINDOW, ACCENT } from '../config.js';
import { fmtDur } from '../lib/format.js';

// 配色（CC 风：无背景，主色青 + 灰阶 + 语义色）
const FG = '#c9d1e9';
const SUB = '#6e7681';
const GREEN = '#7ee787';
const YELLOW = '#d29922';
const RED = '#f85149';
const BLUE = '#58a6ff';

function ctxColor(pct: number): string {
  if (pct < 50) return GREEN;
  if (pct < 80) return YELLOW;
  return RED;
}

// 取当前目录的 git 分支（无 git 返回空）
function gitBranch(cwd: string): string {
  if (!cwd) return '';
  try {
    const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' });
    if (r.status === 0 && r.stdout) return r.stdout.trim();
  } catch { /* noop */ }
  return '';
}

function baseName(p: string): string {
  return p ? (p.split('/').filter(Boolean).pop() ?? p) : p;
}

// CC 风格状态栏：[model] │ cwd git:(branch) │ DeepAnalyze  +  Context ░░ % · perf
export default function StatusBar() {
  const s = useStore();
  const cwd = s.meta?.cwd ?? '';
  const branch = useMemo(() => gitBranch(cwd), [cwd]);
  const cwdBase = baseName(cwd);

  const inTok = (s.usage?.input_tokens ?? 0) as number;
  // context 占用 = 所有进入模型的 token（input + cache_read + cache_creation）。
  // glm 多轮命中 prompt cache 后，input_tokens 只剩增量，cache_read 占大头——只算 input 会严重低估。
  const ctxTok =
    inTok +
    ((s.usage?.cache_read_input_tokens ?? 0) as number) +
    ((s.usage?.cache_creation_input_tokens ?? 0) as number);
  const pct = s.usage ? (ctxTok / CONTEXT_WINDOW) * 100 : 0;
  const filled = s.usage && pct > 0 ? Math.max(1, Math.min(10, Math.round(pct / 10))) : 0;
  const bar = '▓'.repeat(filled) + '░'.repeat(10 - filled);
  const cc = ctxColor(pct);

  const model = s.meta?.model ?? '';
  const o = (s.usage?.output_tokens ?? 0) as number;

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* 行 1：[model] │ cwd git:(branch) │ DeepAnalyze */}
      <Text>
        <Text color={SUB}>  [</Text>
        <Text color={ACCENT} bold>{model}</Text>
        <Text color={SUB}>] │ </Text>
        <Text color={FG}>{cwdBase}</Text>
        {branch ? <Text color={SUB}> git:(</Text> : null}
        {branch ? <Text color={ACCENT}>{branch}</Text> : null}
        {branch ? <Text color={SUB}>)</Text> : null}
        <Text color={SUB}> │ </Text>
        <Text color={FG}>leow3bot</Text>
      </Text>
      {/* 行 2：Context ░░ % · ↑in ↓out · TTFT · TPOT · tok/s */}
      <Text>
        <Text color={SUB}>  Context </Text>
        <Text color={cc}>{bar} </Text>
        <Text color={cc} bold>{s.usage ? `${pct.toFixed(0)}%` : '—'}</Text>
        <Text color={SUB}> ({ctxTok.toLocaleString()}/{CONTEXT_WINDOW.toLocaleString()})</Text>
        {s.usage ? (
          <>
            <Text color={SUB}>  ·  </Text>
            <Text color={GREEN}>↑{ctxTok.toLocaleString()}</Text>
            <Text color={SUB}> </Text>
            <Text color={BLUE}>↓{o.toLocaleString()}</Text>
            {s.timing?.ttft != null ? (<><Text color={SUB}>  ·  </Text><Text color={YELLOW}>TTFT {fmtDur(s.timing.ttft / 1000)}</Text></>) : null}
            {s.timing?.decode_time != null && o > 1 ? (
              <>
                <Text color={SUB}>  ·  </Text>
                <Text color={FG}>TPOT {(s.timing.decode_time / (o - 1)).toFixed(0)}ms</Text>
                <Text color={SUB}>  ·  </Text>
                <Text color={FG}>{((o - 1) / (s.timing.decode_time / 1000)).toFixed(1)} tok/s</Text>
              </>
            ) : null}
          </>
        ) : null}
      </Text>
    </Box>
  );
}
