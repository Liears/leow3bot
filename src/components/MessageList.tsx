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
function lineMarginTop(kind: CommittedItem['kind']): number {
  // 统一空一行（段内行、块首行都 1）；tool_result / logo 紧贴所属块
  if (kind === 'assistant_line' || kind === 'thinking_line' || kind === 'user' || kind === 'tool_start' || kind === 'system') return 1;
  return 0;
}

export default function MessageList({ item }: { item: CommittedItem }) {
  const mt = lineMarginTop(item.kind);
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
    case 'tool_start': {
      // subagent 特例（CC 的 Task(Explore) 风格）：类型进括号，摘要用一句话
      // description（无则 prompt 前缀）——长 prompt 绝不整坨 JSON 进 scrollback
      if (item.call.name === 'subagent') {
        const at = typeof item.call.input.agent_type === 'string' && item.call.input.agent_type
          ? item.call.input.agent_type : 'explore';
        const d = typeof item.call.input.description === 'string' && item.call.input.description.trim()
          ? item.call.input.description
          : String(item.call.input.prompt ?? '').replace(/\s+/g, ' ');
        return (
          <Box marginTop={1}>
            <Text color={ACCENT} bold>{SYM_TOOL} subagent({at}) </Text>
            <Text dimColor>{clip(d, 60)}</Text>
          </Box>
        );
      }
      return (
        <Box marginTop={1}>
          <Text color={ACCENT} bold>{SYM_TOOL} {item.call.name} </Text>
          <Text dimColor>{summarizeInput(item.call.name, item.call.input)}</Text>
        </Box>
      );
    }
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
                {Array.from({ length: maxW }, (_, ci) => {
                  const glyph = line[ci] ?? ' ';
                  const isWinCube = glyph === '[' || glyph === 'W' || glyph === ']';
                  return (
                    <Text
                      key={ci}
                      color={isWinCube ? 'white' : gradientHex(ci / Math.max(1, maxW - 1))}
                      bold={isWinCube}
                    >
                      {glyph}
                    </Text>
                  );
                })}
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

/** 压平空白并截断（超长加省略号） */
function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function summarizeInput(name: string, input: Record<string, unknown>): string {
  // 常用工具取最代表调用的一个字段（对齐 CC 的 Tool(arg) 风格），其余回退 JSON
  const prefer: Record<string, string> = {
    bash: 'command', read: 'path', view: 'path', edit: 'path', write: 'path',
    web_search: 'query', web_fetch: 'url', skill: 'name', ask: 'question',
  };
  const key = prefer[name];
  const v = key ? input[key] : undefined;
  const s = typeof v === 'string' && v.trim() ? v : JSON.stringify(input);
  return clip(s, 70);
}

function summarizeResult(result: unknown): string {
  let s: string;
  if (typeof result === 'string') s = result;
  else if (result && typeof result === 'object' && 'output' in result) s = String((result as { output: unknown }).output);
  else s = JSON.stringify(result);
  return clip(s, 120);
}
