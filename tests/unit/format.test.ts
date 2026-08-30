// 纯函数辅助单测：fmtSize/fmtDur/gradientHex/truncateMiddle（lib/format.ts）。
import { describe, it, expect } from 'vitest';
import { fmtSize, fmtDur, gradientHex, GRADIENT_STOPS, truncateMiddle } from '../../src/lib/format.js';

describe('fmtSize', () => {
  it('字节级', () => expect(fmtSize(512)).toBe('512 B'));
  it('1023 B 不进位', () => expect(fmtSize(1023)).toBe('1023 B'));
  it('KB 一位小数', () => expect(fmtSize(2048)).toBe('2.0 KB'));
  it('MB 一位小数', () => expect(fmtSize(1024 * 1024 * 1.5)).toBe('1.5 MB'));
});

describe('fmtDur', () => {
  it('null/undefined → N/A', () => {
    expect(fmtDur(null)).toBe('N/A');
    expect(fmtDur(undefined)).toBe('N/A');
  });
  it('<1s → 毫秒取整', () => expect(fmtDur(0.123)).toBe('123ms'));
  it('≥1s → 两位小数秒', () => expect(fmtDur(1.5)).toBe('1.50s'));
});

describe('gradientHex', () => {
  it('t=0 → 首停色，t=1 → 末停色', () => {
    expect(gradientHex(0)).toBe(GRADIENT_STOPS[0].toLowerCase());
    expect(gradientHex(1)).toBe(GRADIENT_STOPS[1].toLowerCase());
  });
  it('t 越界钳制到 [0,1]', () => {
    expect(gradientHex(-1)).toBe(gradientHex(0));
    expect(gradientHex(2)).toBe(gradientHex(1));
  });
  it('多停色带：中间值在停色之间', () => {
    const mid = gradientHex(0.5, ['#000000', '#ffffff']);
    expect(mid).toBe('#808080');
  });
});

describe('truncateMiddle', () => {
  it('不超限原样返回', () => {
    expect(truncateMiddle('short', 100)).toBe('short');
  });
  it('超限保留头尾 + 省略说明', () => {
    const text = 'A'.repeat(600) + 'END';
    const out = truncateMiddle(text, 100);
    expect(out.startsWith('A'.repeat(60))).toBe(true);   // 头部 60%
    expect(out.endsWith('END')).toBe(true);               // 尾部保留
    expect(out).toContain('中间省略');                     // 省略标注
    expect(out.length).toBeLessThan(200);                 // 结果显著短于原文
  });
});
