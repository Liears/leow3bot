import React from 'react';
import { Box, Text } from 'ink';
import type { CommittedItem } from '../types.js';
import { SYM_USER, SYM_TOOL, SYM_RESULT, SYM_THINK, ACCENT } from '../config.js';
import { gradientHex } from '../lib/format.js';
import { renderMarkdownLine, renderInline } from '../lib/markdown.js';

// 行距规则（Static 增量渲染只渲染新行、不更新旧行，所以每行只能靠自己的
// marginTop 与上一行拉开距离，不能合并分组——合并会让数组长度不变、
// Static 认为无新内容导致新行永不渲染）：
//   段内行（前一行是同类型 assistant_line/thinking_line）→ marginTop 2
//   块首行（user/tool_start/system/段落第一行）→ marginTop 1
//   tool_result / logo → 0（紧贴所属块）
function lineMarginTop(kind: CommittedItem['kind'], prevKind: CommittedItem['kind'] | undefined): number {
  if (kind === 'assistant_line' || kind === 'thinking_line') {
    return prevKind === kind ? 2 : 1;
  }
  if (kind === 'user' || kind === 'tool_start' || kind === 'system') return 1;
  return 0;
}

export default function MessageList({ item, prevKind }: { item: CommittedItem; prevKind?: CommittedItem['kind'] }) {
  const mt = lineMarginTop(item.kind, prevKind);
  switch (item.kind) {
    case 'user':
      return (
        <Box marginTop={mt}>
          <Text color={ACCENT} bold>{SYM_USER} </Text>
          <Text color={ACCENT}>{item.text}</Text>
        </Box>
      );
    case 'assistant_line':
      return <Box marginTop={mt}>{renderMarkdownLine(item.text, item.code ?? false)}</Box>;
    case 'thinking_line':
      return (
        <Box flexDirection="column" marginTop={mt}>
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
