import React from 'react';
import { Text } from 'ink';

// 行内 markdown → ink <Text> 片段（嵌套在父 <Text> 内，子片段样式叠加）。
// 处理 **bold**、`code`、*italic*、[link](url)。未匹配的字面量当普通文本。
const INLINE_RE = /(\*\*([^*]+)\*\*|`([^`]+)`|\*([^*\n]+)\*|\[([^\]]+)\]\(([^)]+)\))/g;

export function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(<Text key={key++}>{text.slice(last, m.index)}</Text>);
    if (m[2] !== undefined) nodes.push(<Text key={key++} bold>{m[2]}</Text>);
    else if (m[3] !== undefined) nodes.push(<Text key={key++} color="cyan">{m[3]}</Text>);
    else if (m[4] !== undefined) nodes.push(<Text key={key++} italic>{m[4]}</Text>);
    else if (m[5] !== undefined) nodes.push(<Text key={key++} underline>{m[5]}</Text>);
    last = INLINE_RE.lastIndex;
  }
  if (last < text.length) nodes.push(<Text key={key++}>{text.slice(last)}</Text>);
  return nodes.length ? nodes : [<Text key={0}>{text}</Text>];
}

const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^(#{1,6})\s+(.*)/;
const UL_RE = /^\s*([-*+])\s+(.*)/;
const OL_RE = /^\s*(\d+)\.\s+(.*)/;
const BQ_RE = /^>\s?(.*)/;

// 渲染一行 markdown。inCode = 该行是否处于代码块内部（由 store 跨行维护，调用方传入）。
export function renderMarkdownLine(text: string, inCode: boolean): React.ReactElement {
  if (FENCE_RE.test(text)) return <Text dimColor>{'─'.repeat(3)}</Text>;
  if (inCode) return <Text dimColor>{text || ' '}</Text>;
  const h = HEADING_RE.exec(text);
  if (h) return <Text bold color={h[1].length <= 2 ? 'magenta' : 'blue'}>{renderInline(h[2])}</Text>;
  const ul = UL_RE.exec(text);
  if (ul) return <Text><Text color="cyan">• </Text>{renderInline(ul[2])}</Text>;
  const ol = OL_RE.exec(text);
  if (ol) return <Text><Text color="cyan">{ol[1]}. </Text>{renderInline(ol[2])}</Text>;
  const bq = BQ_RE.exec(text);
  if (bq) return <Text><Text color="gray">│ </Text>{renderInline(bq[1])}</Text>;
  return <Text>{renderInline(text)}</Text>;
}
