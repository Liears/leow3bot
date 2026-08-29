import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { ACCENT, DEFAULT_API_BASE_URL } from '../config.js';

interface Props {
  onDone: (cfg: { apiBaseUrl: string; apiKey: string; model: string; contextWindow: number }) => void;
}

// 端点输入归一化：空 → 默认；缺 scheme 补 https://；URL 解析失败返回 null
// （落盘前拦截——无效 URL 会在下次启动 getProviderLabel 的 new URL() 处崩死
// 整个 CLI，用户连 onboarding 都进不去，code-review F2）
function normalizeUrl(raw: string): string | null {
  let u = raw.trim();
  if (!u) return DEFAULT_API_BASE_URL;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const parsed = new URL(u);
    return parsed.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

// 首次启动引导（四步）：API 端点 → API Key → 选模型 → 上下文窗口长度。
// max_tokens 不问——错误驱动自动学习（撞端点超限 400 提取上限并按模型缓存）。
// 完成后由 App 调 applyRuntimeConfig 一次性写入 ~/.leow3bot/config.json，无需重启。
// 模型列表来自端点 /v1/models（↑↓ 选择，最新在前）；拉取失败退化为手动输入模型名。
export default function Onboarding({ onDone }: Props) {
  const [step, setStep] = useState<'url' | 'key' | 'model' | 'context'>('url');
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [ctx, setCtx] = useState('');
  const [err, setErr] = useState('');
  // 模型步状态
  const [models, setModels] = useState<string[] | null>(null); // null = 加载中
  const [modelFallback, setModelFallback] = useState(false); // 列表失败 → 手动输入
  const [sel, setSel] = useState(0);

  const baseUrl = url.trim() || DEFAULT_API_BASE_URL;

  // key 完成进入模型步后拉列表（用刚输入的端点+key，配置尚未落盘）
  useEffect(() => {
    if (step !== 'model') return;
    let alive = true;
    (async () => {
      try {
        const r = await fetch(baseUrl.replace(/\/+$/, '') + '/v1/models', {
          headers: { Authorization: `Bearer ${key.trim()}` },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { data?: Array<{ id?: unknown; created_at?: unknown }> };
        const list = (j.data ?? [])
          .map(m => ({ id: String(m?.id ?? ''), at: String(m?.created_at ?? '') }))
          .filter(m => m.id)
          .sort((a, b) => b.at.localeCompare(a.at))
          .map(m => m.id);
        if (!alive) return;
        if (list.length) { setModels(list); setSel(0); }
        else setModelFallback(true);
      } catch {
        if (alive) setModelFallback(true); // 端点不支持 /v1/models / 网络 → 手动输入
      }
    })();
    return () => { alive = false; };
  }, [step]);

  // 模型列表步的键盘导航（url/key/context 步由 TextInput 接管，此处忽略）
  useInput((_input, k) => {
    if (step !== 'model' || !models) return;
    if (k.upArrow) setSel(i => Math.max(0, i - 1));
    else if (k.downArrow) setSel(i => Math.min(models.length - 1, i + 1));
    else if (k.return) {
      setModel(models[sel]);
      setStep('context');
    }
  });

  function finish(contextWindow: number) {
    onDone({ apiBaseUrl: baseUrl, apiKey: key.trim(), model: model || 'glm-5.1', contextWindow });
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="column">
        <Text color={ACCENT} bold>╭─ 欢迎使用 leow3bot · 首次配置</Text>
        <Text dimColor>╰─ 四步完成，自动写入 ~/.leow3bot/config.json（联网搜索默认复用同一 key）</Text>
      </Box>

      <Box marginTop={1}>
        <Text color={ACCENT} bold>  ① API 端点 </Text>
        {step === 'url' ? (
          <TextInput
            value={url}
            placeholder={DEFAULT_API_BASE_URL}
            onChange={(v) => { setUrl(v); setErr(''); }}
            onSubmit={() => {
              const n = normalizeUrl(url);
              if (!n) { setErr('端点 URL 无效（示例: https://open.bigmodel.cn/api/anthropic）'); return; }
              setUrl(n);
              setStep('key');
            }}
          />
        ) : (
          <Text>{baseUrl}</Text>
        )}
      </Box>

      {step === 'key' || step === 'model' || step === 'context' ? (
        <Box>
          <Text color={ACCENT} bold>  ② API Key  </Text>
          {step === 'key' ? (
            <TextInput
              value={key}
              placeholder="智谱 BigModel apiKey（https://open.bigmodel.cn）"
              onChange={(v) => { setKey(v); setErr(''); }}
              onSubmit={() => {
                if (!key.trim()) { setErr('API Key 不能为空'); return; }
                setStep('model');
              }}
            />
          ) : (
            <Text dimColor>✓ {key.trim().slice(0, 6)}…{key.trim().slice(-4)}</Text>
          )}
        </Box>
      ) : null}

      {step === 'model' ? (
        <Box flexDirection="column">
          <Text color={ACCENT} bold>  ③ 选择模型 </Text>
          {modelFallback ? (
            <Box>
              <Text dimColor>    模型名 </Text>
              <TextInput
                value={model}
                placeholder="glm-5.1（列表获取失败，手动输入）"
                onChange={(v) => { setModel(v); setErr(''); }}
                onSubmit={() => setStep('context')}
              />
            </Box>
          ) : models ? (
            <Box flexDirection="column">
              <Text dimColor>    ↑↓ 选择 · Enter 确认 · 共 {models.length} 个（新→旧）</Text>
              {models.slice(0, 8).map((m, i) => (
                <Box key={m} paddingLeft={4}>
                  <Text color={i === sel ? ACCENT : undefined} bold={i === sel}>
                    {i === sel ? '▶ ' : '  '}{m}
                  </Text>
                </Box>
              ))}
              {models.length > 8 ? <Text dimColor>    …</Text> : null}
            </Box>
          ) : (
            <Text dimColor>    正在获取模型列表…</Text>
          )}
        </Box>
      ) : null}

      {step === 'context' ? (
        <Box flexDirection="column">
          <Box>
            <Text color={ACCENT} bold>  ④ 上下文窗口 </Text>
            <TextInput
              value={ctx}
              placeholder="192000（回车使用默认；模型能同时容纳的 token 总量）"
              onChange={(v) => { setCtx(v); setErr(''); }}
              onSubmit={() => {
                const t = ctx.trim();
                if (!t) { finish(192000); return; }
                const n = Number(t);
                if (!Number.isInteger(n) || n < 4096 || n > 10_000_000) {
                  setErr('上下文长度需为 4096 - 10000000 的整数（回车 = 默认 192000）');
                  return;
                }
                finish(n);
              }}
            />
          </Box>
          <Text dimColor>  模型: {model || 'glm-5.1'} · 输出上限(max_tokens)无需填写——首次请求自动学习</Text>
        </Box>
      ) : null}

      {err ? <Box marginLeft={2}><Text color="red">{err}</Text></Box> : null}
    </Box>
  );
}
