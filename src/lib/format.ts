// 纯函数辅助（移植 ui.py 的 fmt_size/fmt_dur）

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function fmtDur(s: number | null | undefined): string {
  if (s === null || s === undefined) return 'N/A';
  return s < 1 ? `${Math.round(s * 1000)}ms` : `${s.toFixed(2)}s`;
}

// 默认渐变色带（深青 → 浅青，同色系冷色，呼应主色 #06B6D4），logo / 名称逐字符着色用。
export const GRADIENT_STOPS = ['#0891B2', '#22D3EE'];

// 在色带上按 t∈[0,1] 线性插值出一个 hex 颜色（ink <Text color> 接受 '#rrggbb'）。
export function gradientHex(t: number, stops: string[] = GRADIENT_STOPS): string {
  const x = Math.max(0, Math.min(1, t));
  const n = stops.length - 1;
  const seg = x * n;
  const i = Math.min(Math.floor(seg), n - 1);
  const f = seg - i;
  const a = hexToRgb(stops[i]);
  const b = hexToRgb(stops[i + 1]);
  return rgbToHex(
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  );
}

function hexToRgb(h: string): [number, number, number] {
  const s = h.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}
