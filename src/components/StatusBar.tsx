import React from 'react';
import { homedir } from 'node:os';
import { Box, Text, useStdout } from 'ink';
import { useStore } from '../store.js';
import { CONTEXT_WINDOW, ACCENT } from '../config.js';
import { fmtDur, gradientHex } from '../lib/format.js';

// 中性深色面板配色（GitHub Dark 系）
const BG = '#0d1117';
const FG = '#c9d1d9';
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

type Seg = { t: string; c?: string; b?: boolean; bg?: string };

// 面板行：精确填充——算 segments 可见字符长（码点），补空格铺满终端宽，不 truncate、无 …。
function Row({ segs }: { segs: Seg[] }) {
  const { stdout } = useStdout();
  const w = stdout?.columns ?? 80;
  const len = segs.reduce((n, s) => n + [...s.t].length, 0);
  const pad = Math.max(0, w - len - 2);
  return (
    <Text backgroundColor={BG}>
      {' '}
      {segs.map((s, i) => (
        <Text key={i} color={s.c} bold={s.b} backgroundColor={s.bg}>{s.t}</Text>
      ))}
      {' '.repeat(pad)}
      {' '}
    </Text>
  );
}

// 键位高亮样式：橙底白字加粗（kbd 风格）
const KBD = { c: '#ffffff', b: true, bg: ACCENT };

// 深色面板状态栏：每行精确铺满。末行突出 Ctrl+V 粘贴图片 + /help 指南（kbd 块 + emoji + 说明）。
export default function StatusBar() {
  const s = useStore();
  const inTok = (s.usage?.input_tokens ?? 0) as number;
  const pct = s.usage ? (inTok / CONTEXT_WINDOW) * 100 : 0;
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  const bar = '▰'.repeat(filled) + '▱'.repeat(10 - filled);
  const cc = ctxColor(pct);

  const model = s.meta?.model ?? '';
  const tools = s.meta ? `${s.meta.nTools} tools` + (s.meta.nSkills ? ` · ${s.meta.nSkills} skills` : '') : '';
  const cwd = s.meta ? shortenCwd(s.meta.cwd) : '';

  const mcSegs: Seg[] = 'MC'.split('').map((c, i) => ({ t: c, c: gradientHex(i), b: true }));

  const rows: Seg[][] = [];
  rows.push([...mcSegs, { t: '  ' + model, c: FG, b: true }, { t: '  ·  ' + tools, c: SUB }]);
  rows.push([{ t: cwd, c: SUB }]);
  rows.push([
    { t: 'context ', c: SUB },
    { t: bar + ' ', c: cc },
    { t: s.usage ? `${pct.toFixed(0)}%` : '—', c: cc, b: true },
    { t: ' · ' + inTok.toLocaleString(), c: SUB },
  ]);

  const perfSegs: Seg[] = [];
  if (s.usage) {
    const o = (s.usage.output_tokens ?? 0) as number;
    perfSegs.push({ t: 'perf ', c: SUB });
    perfSegs.push({ t: '↑' + inTok.toLocaleString(), c: GREEN });
    perfSegs.push({ t: ' ', c: SUB });
    perfSegs.push({ t: '↓' + o.toLocaleString(), c: BLUE });
    if (s.timing?.ttft != null) {
      perfSegs.push({ t: ' · ', c: SUB });
      perfSegs.push({ t: 'TTFT ' + fmtDur(s.timing.ttft / 1000), c: YELLOW });
    }
    if (s.timing?.decode_time != null && o > 1) {
      const tpot = s.timing.decode_time / (o - 1);
      const decodeRate = (o - 1) / (s.timing.decode_time / 1000);
      perfSegs.push({ t: ' · ', c: SUB });
      perfSegs.push({ t: 'TPOT ' + tpot.toFixed(0) + 'ms', c: FG });
      perfSegs.push({ t: ' · ', c: SUB });
      perfSegs.push({ t: decodeRate.toFixed(1) + ' tok/s', c: BLUE });
    }
  } else {
    perfSegs.push({ t: 'perf —', c: SUB });
  }
  rows.push(perfSegs);

  // 末行：突出两个最重要的操作——粘贴图片 + 使用指南（kbd 块 + 说明，去 emoji 更克制）
  rows.push([
    { t: '  ' },
    { ...KBD, t: ' Ctrl+V ' },
    { t: ' 粘贴图片    ', c: FG },
    { ...KBD, t: ' /help ' },
    { t: ' 使用指南 ', c: FG },
  ]);

  return (
    <Box flexDirection="column" marginTop={1}>
      {rows.map((segs, i) => (
        <Row key={i} segs={segs} />
      ))}
    </Box>
  );
}

function shortenCwd(cwd: string): string {
  const home = homedir();
  return home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
}
