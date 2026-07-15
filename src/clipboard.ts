// 剪贴板图片读取（移植 clipboard.py）。返回 raw PNG Buffer 或 null。
// 顺序：WSL2 powershell.exe → xclip → wl-paste → macOS osascript → Windows powershell。

import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

function has(bin: string): boolean {
  const r = spawnSync('which', [bin], { stdio: 'ignore' });
  return r.status === 0;
}

function readWslPowershell(): Buffer | null {
  if (process.platform !== 'linux' || !has('powershell.exe')) return null;
  const cmd =
    'Add-Type -AssemblyName System.Drawing; ' +
    "$img = Get-Clipboard -Format Image; " +
    'if ($img) { ' +
    '$ms = New-Object System.IO.MemoryStream; ' +
    '$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); ' +
    '[Convert]::ToBase64String($ms.ToArray()) ' +
    '}';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd], { timeout: 15_000, maxBuffer: 20 * 1024 * 1024 });
  const out = (r.stdout?.toString('utf-8') ?? '').trim();
  if (!out) return null;
  return Buffer.from(out, 'base64');
}

function readXclip(): Buffer | null {
  if (process.platform !== 'linux' || !has('xclip')) return null;
  const chk = spawnSync('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'], { timeout: 5000 });
  if (chk.status !== 0 || !chk.stdout?.toString().includes('image/')) return null;
  const r = spawnSync('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], { timeout: 5000 });
  return r.status === 0 && r.stdout?.length ? r.stdout : null;
}

function readWlPaste(): Buffer | null {
  if (process.platform !== 'linux' || !has('wl-paste')) return null;
  const chk = spawnSync('wl-paste', ['-l'], { timeout: 5000 });
  if (chk.status !== 0 || !chk.stdout?.toString().includes('image/')) return null;
  const r = spawnSync('wl-paste', ['--type', 'image/png'], { timeout: 5000 });
  return r.status === 0 && r.stdout?.length ? r.stdout : null;
}

function readDarwin(): Buffer | null {
  if (process.platform !== 'darwin') return null;
  // 用 clipboard info 判断图片格式（输出小）；不能用 as 直接检查——大图会撑爆 spawnSync 默认 1MB maxBuffer
  const info = spawnSync('osascript', ['-e', 'clipboard info'], { timeout: 5000 });
  const infoStr = (info.stdout ?? '').toString();
  const cls = infoStr.includes('PNGf') ? 'PNGf' : infoStr.includes('TIFF') ? 'TIFF' : null;
  if (!cls) return null;
  const ext = cls === 'PNGf' ? 'png' : 'tiff';
  const tmp = path.join(tmpdir(), `mc-clip-${Date.now()}.${ext}`);
  try {
    // 图片数据写到临时文件（不经 stdout，避开 maxBuffer），sharp 下游统一转 PNG
    const script =
      `set img_data to (the clipboard as «class ${cls}»)\n` +
      `set fp to open for access POSIX file "${tmp}" with write permission\n` +
      'write img_data to fp\n' +
      'close access fp';
    const r = spawnSync('osascript', ['-e', script], { timeout: 10_000 });
    if (r.status !== 0 || !existsSync(tmp) || statSync(tmp).size === 0) return null;
    return readFileSync(tmp);
  } finally {
    try { unlinkSync(tmp); } catch { /* noop */ }
  }
}

function readWindows(): Buffer | null {
  if (process.platform !== 'win32' || !has('powershell')) return null;
  const tmp = path.join(tmpdir(), `mc-clip-${Date.now()}.png`);
  try {
    const cmd =
      'Add-Type -AssemblyName System.Drawing; ' +
      "$img = Get-Clipboard -Format Image; " +
      `if ($img) { $img.Save('${tmp}', [System.Drawing.Imaging.ImageFormat]::Png) }`;
    const r = spawnSync('powershell', ['-NoProfile', '-Command', cmd], { timeout: 15_000 });
    if (r.status !== 0 || !existsSync(tmp) || statSync(tmp).size === 0) return null;
    return readFileSync(tmp);
  } finally {
    try { unlinkSync(tmp); } catch { /* noop */ }
  }
}

export function getClipboardImage(): Buffer | null {
  for (const reader of [readWslPowershell, readXclip, readWlPaste, readDarwin, readWindows]) {
    try {
      const data = reader();
      if (data) return data;
    } catch { /* 下一个 */ }
  }
  return null;
}
