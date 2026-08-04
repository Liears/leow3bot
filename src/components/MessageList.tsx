import React from 'react';
import { Box, Text } from 'ink';
import type { CommittedItem } from '../types.js';
import { SYM_USER, SYM_TOOL, SYM_RESULT, SYM_THINK, ACCENT } from '../config.js';
import { gradientHex } from '../lib/format.js';
import { renderMarkdownLine, renderInline } from '../lib/markdown.js';

// 渲染分组：流式按行 commit，同一回复的连续 assistant_line / thinking_line
// 合并成一个段落，段内每行加 gap（行距），段与段之间由 marginTop 分隔。
export type GroupedItem =
  | { kind: 'para'; sub: 'assistant' | 'thinking'; lines: Array<{ text: string; code?: boolean }> }
  | CommittedItem;

export function groupCommitted(items: CommittedItem[]): GroupedItem[] {
  const out: GroupedItem[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (it.kind === 'assistant_line' && last && last.kind === 'para' && last.sub === 'assistant') {
      last.lines.push({ text: it.text, code: it.code ?? false });
    } else if (it.kind === 'thinking_line' && last && last.kind === 'para' && last.sub === 'thinking') {
      last.lines.push({ text: it.text });
    } else if (it.kind === 'assistant_line') {
      out.push({ kind: 'para', sub: 'assistant', lines: [{ text: it.text, code: it.code ?? false }] });
    } else if (it.kind === 'thinking_line') {
      out.push({ kind: 'para', sub: 'thinking', lines: [{ text: it.text }] });
    } else {
      out.push(it);
    }
  }
  return out;
}

export default function MessageList({ item }: { item: GroupedItem }) {
  // 段落：同一回复的连续行，行与行之间空一行（gap），不再是紧贴的密排
  if (item.kind === 'para') {
    if (item.sub === 'assistant') {
      return (
        <Box flexDirection="column" gap={2}>
          {item.lines.map((l, i) => <Box key={i}>{renderMarkdownLine(l.text, l.code ?? false)}</Box>)}
        </Box>
      );
    }
    return (
      <Box flexDirection="column" gap={2}>
        {item.lines.map((l, i) => (
          <Text key={i} dimColor italic>{i === 0 ? `${SYM_THINK} ` : '  '}{renderInline(l.text)}</Text>
        ))}
      </Box>
    );
  }

  switch (item.kind) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color={ACCENT} bold>{SYM_USER} </Text>
          <Text color={ACCENT}>{item.text}</Text>
        </Box>
      );
    case 'thinking_line':
      // 正常不会走到（thinking_line 已被分组）；兜底渲染
      return (
        <Box flexDirection="column">
          {item.text.split('\n').map((l, i) => (
            <Text key={i} dimColor italic>{i === 0 ? `${SYM_THINK} ` : '  '}{renderInline(l)}</Text>
          ))}
        </Box>
      );
    case 'tool_start':
      return (
        <Box marginTop={1}>
          <Text color={ACCENT} bold>{SYM_TOOL} {item.call.name} </Text>
          <Text dimColor>{summarizeInput(item.call.input)}</Text>
        </Box>
      );
    case 'tool_result':
      return (
        <Box>
          <Text dimColor>  {SYM_RESULT}  </Text>
          <Text dimColor>{summarizeResult(item.result)}</Text>
        </Box>
      );
    case 'system': {
      const color = item.tone === 'err' ? 'red' : item.tone === 'ok' ? 'green' : item.tone === 'warn' ? 'yellow' : undefined;
      return (
        <Box marginTop={1}>
          <Text color={color} dimColor={item.tone === 'muted'}>{item.text}</Text>
        </Box>
      );
    }
    case 'logo': {
      // logo + 右侧多行信息横向并排；logo 逐字符渐变，右侧首行（名称）渐变，其余 dimColor。
      const maxW = Math.max(...item.logo.map(l => l.length));
      const info = item.info ?? [item.name];
      return (
        <Box alignItems="center" gap={2}>
          <Box flexDirection="column">
            {item.logo.map((line, ri) => (
              <Text key={ri}>
                {Array.from({ length: maxW }, (_, ci) => (
                  <Text key={ci} color={gradientHex(ci / Math.max(1, maxW - 1))}>{line[ci] ?? ' '}</Text>
                ))}
              </Text>
            ))}
          </Box>
          <Box flexDirection="column">
            {info.map((line, li) => (
              <Text key={li} bold={li === 0} dimColor={li > 0}>
                {li === 0
                  ? line.split('').map((ch, ci) => (
                      <Text key={ci} color={gradientHex(ci / Math.max(1, line.length - 1))}>{ch}</Text>
                    ))
                  : line}
              </Text>
            ))}
          </Box>
        </Box>
      );
    }
  }
}

function summarizeInput(input: Record<string, unknown>): string {
  const s = JSON.stringify(input);
  return s.length > 70 ? s.slice(0, 67) + '...' : s;
}

function summarizeResult(result: unknown): string {
  let s: string;
  if (typeof result === 'string') s = result;
  else if (result && typeof result === 'object' && 'output' in result) s = String((result as { output: unknown }).output);
  else s = JSON.stringify(result);
  s = s.replace(/\n/g, ' ').slice(0, 120);
  return s;
}
