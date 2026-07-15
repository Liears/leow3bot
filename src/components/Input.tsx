import React, { useState, useMemo, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { SYM_USER, ACCENT } from '../config.js';
import { COMMANDS } from '../commands.js';
import { getClipboardImage } from '../clipboard.js';
import { compressImage } from '../tools.js';
import { getState, setAskResolver } from '../store.js';
import { fmtSize } from '../lib/format.js';
import type { PastedImg } from '../agent.js';

interface Props {
  onSubmit: (text: string, images: PastedImg[]) => void;
  promptLabel?: string; // ask 模式自定义前缀
}

// 输入框 + Tab 命令补全 + Ctrl-V 粘贴剪贴板图片 + ask 模式 resolve。
// ESC 中断流式在 App.tsx 全局处理。
export default function Input({ onSubmit, promptLabel }: Props) {
  const [value, setValue] = useState('');
  const [compIdx, setCompIdx] = useState(-1);
  const [feedback, setFeedback] = useState('');
  const pasted = useRef(new Map<number, PastedImg>());
  const nextId = useRef(1);

  const isAsk = getState().askResolver !== null;

  const matches = useMemo(() => {
    if (isAsk) return []; // ask 模式不补全命令
    if (value.startsWith('/') && !value.includes(' ')) return COMMANDS.filter(c => c.startsWith(value.slice(1)));
    return [];
  }, [value, isAsk]);

  useInput((input, key) => {
    if (key.tab && matches.length) {
      setCompIdx(i => {
        const next = (i + 1) % matches.length;
        setValue('/' + matches[next]); // Tab 即时补全到输入框
        return next;
      });
    }
    if (key.ctrl && input === 'v') void doPaste();
  });

  async function doPaste() {
    const raw = getClipboardImage();
    if (!raw) { setFeedback('剪贴板里没有图片'); return; }
    const { data, mediaType } = await compressImage(raw, '.png');
    const id = nextId.current++;
    pasted.current.set(id, { data, mediaType, dims: '?' });
    // 抹掉 TextInput 在 ctrl+v 时误追加的 'v'（它没拦截 ctrl+v），再插入 [Image #N]
    setValue(v => v.replace(/v$/, '') + `[Image #${id}] `);
    setFeedback(`✓ Image #${id} · ${mediaType} · ${fmtSize(data.length)}`);
  }

  const submit = () => {
    const useComp = compIdx >= 0 && matches.length > 0 && !isAsk;
    const raw = useComp ? '/' + matches[compIdx] : value;
    setValue('');
    setCompIdx(-1);
    if (!raw.trim()) return;

    // ask 模式：resolve askResolver
    const s = getState();
    if (s.askResolver) {
      s.askResolver(raw);
      setAskResolver(null);
      return;
    }

    // 解析 [Image #N] → images
    const imgs: PastedImg[] = [];
    const text = raw.replace(/\[Image #(\d+)\]/g, (m, n) => {
      const img = pasted.current.get(Number(n));
      if (img) imgs.push(img);
      return m;
    });
    pasted.current.clear();
    nextId.current = 1;
    setFeedback('');
    onSubmit(text, imgs);
  };

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={ACCENT} bold>{promptLabel ?? SYM_USER} </Text>
        <TextInput value={value} onChange={(v) => { setValue(v); setCompIdx(-1); }} onSubmit={submit} />
      </Box>
      {matches.length > 0 ? (
        <Box flexDirection="column" marginLeft={2}>
          {matches.slice(0, 8).map((c, i) => (
            <Text key={c} color={i === compIdx ? ACCENT : undefined} bold={i === compIdx}>
              {i === compIdx ? '▶ ' : '  '}/{c}
            </Text>
          ))}
        </Box>
      ) : null}
      {feedback ? <Box marginLeft={2}><Text dimColor>{feedback}</Text></Box> : null}
    </Box>
  );
}
