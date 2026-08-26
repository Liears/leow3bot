// 大体积工具输出落盘（bash / web_fetch 共用）：/tmp/leow3bot-{uid}/，
// 落盘时顺带清理超过 24h 的旧文件（WSL2 的 /tmp 不随重启清理，防目录无限增长）。
// 返回文件路径；失败返回 ''（调用方仅少一个取回路径提示，不阻断返回）。

import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PERSIST_DIR = path.join(
  tmpdir(),
  `leow3bot-${typeof process.getuid === 'function' ? process.getuid() : 0}`,
); // 多用户共享 /tmp 防权限冲突（对齐 CC 的 claude-{uid}）

export function persistToolOutput(kind: string, content: string): string {
  try {
    mkdirSync(PERSIST_DIR, { recursive: true });
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const f of readdirSync(PERSIST_DIR)) {
      const fp = path.join(PERSIST_DIR, f);
      try { if (statSync(fp).mtimeMs < cutoff) unlinkSync(fp); } catch { /* noop */ }
    }
    const fp = path.join(PERSIST_DIR, `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    writeFileSync(fp, content, 'utf-8');
    return fp;
  } catch { return ''; }
}
