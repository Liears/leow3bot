import React from 'react';
import { Box, Text } from 'ink';
import type { CommittedItem } from '../types.js';
import { SYM_USER, SYM_TOOL, SYM_RESULT, SYM_THINK, ACCENT } from '../config.js';
import { gradientHex } from '../lib/format.js';
import { renderMarkdownLine, renderInline } from '../lib/markdown.js';

export default function MessageList({ item }: { item: CommittedItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <Box>
          <Text color={ACCENT} bold>{SYM_USER} </Text>
          <Text color={ACCENT}>{item.text}</Text>
        </Box>
      );
    case 'assistant_line':
      return <Box>{renderMarkdownLine(item.text, item.code ?? false).node}</Box>;
    case 'thinking':
      return (
        <Box><Text dimColor italic>{SYM_THINK} {item.text}</Text></Box>
      );
    case 'thinking_line':
      return (
        <Box flexDirection="column">
          {item.text.split('\n').map((l, i) => (
            <Text key={i} dimColor italic>{i === 0 ? `${SYM_THINK} ` : '  '}{renderInline(l)}</Text>
          ))}
        </Box>
      );
    case 'tool_start':
      return (
        <Box>
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
        <Box>
          <Text color={color} dimColor={item.tone === 'muted'}>{item.text}</Text>
        </Box>
      );
    }
    case 'logo': {
      // logo block 与名称横向并排；按「列位置」着色 → 整块水平彩虹，名称逐字符渐变。
      const maxW = Math.max(...item.logo.map(l => l.length));
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
          <Text bold>
            {item.name.split('').map((ch, ni) => (
              <Text key={ni} color={gradientHex(ni / Math.max(1, item.name.length - 1))}>{ch}</Text>
            ))}
          </Text>
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
