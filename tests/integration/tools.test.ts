// 工具实现集成测试（tools.ts）：真 fs/子进程，tmpdir 内实测 read/write/edit/bash/view。
// 覆盖盲覆盖守卫、分页续读、参数防御、图片管线（sharp 压缩/批次预算摊薄）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { TOOLS_REGISTRY, applyBatchImageBudget } from '../../src/tools.js';

const dir = mkdtempSync(path.join(tmpdir(), 'leow3bot-tools-'));

beforeAll(() => { /* 目录由 mkdtemp 创建 */ });
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

const read = TOOLS_REGISTRY['read']!.function as (a: Record<string, unknown>) => Promise<unknown>;
const write = TOOLS_REGISTRY['write']!.function as (a: Record<string, unknown>) => Promise<unknown>;
const edit = TOOLS_REGISTRY['edit']!.function as (a: Record<string, unknown>) => Promise<unknown>;
const bash = TOOLS_REGISTRY['bash']!.function as (a: Record<string, unknown>) => Promise<unknown>;
const view = TOOLS_REGISTRY['view']!.function as (a: Record<string, unknown>) => Promise<unknown>;

describe('read 工具', () => {
  beforeAll(() => {
    writeFileSync(path.join(dir, 'sample.txt'), Array.from({ length: 10 }, (_, i) => `第${i + 1}行内容`).join('\n'));
  });

  it('输出带行号 + 续读提示', async () => {
    const r = await read({ path: path.join(dir, 'sample.txt'), limit: 3 }) as { type: string; content: string };
    expect(r.type).toBe('text');
    expect(r.content).toContain('1  第1行内容');
    expect(r.content).toContain('已读第 1-3 行');
    expect(r.content).toContain('offset=4');
  });

  it('offset 超出总行数 → 明确提示', async () => {
    const r = await read({ path: path.join(dir, 'sample.txt'), offset: 99 }) as { content: string };
    expect(r.content).toContain('超出文件总行数');
  });

  it('offset/limit 非数值 → 参数防御错误', async () => {
    const r = await read({ path: path.join(dir, 'sample.txt'), offset: 'abc' }) as { type: string; message: string };
    expect(r.type).toBe('error');
    expect(r.message).toContain('参数无效');
  });

  it('limit ≤ 0 钳制为 1（防空页死循环）', async () => {
    const r = await read({ path: path.join(dir, 'sample.txt'), offset: 2, limit: 0 }) as { content: string };
    expect(r.content).toContain('2  第2行内容');
    expect(r.content).not.toContain('第3行');
  });

  it('图片文件 → 引导用 view', async () => {
    const p = path.join(dir, 'fake.png');
    writeFileSync(p, 'not really png');
    const r = await read({ path: p }) as { type: string; message: string };
    expect(r.type).toBe('error');
    expect(r.message).toContain('view');
  });

  it('不存在的文件 → 错误不抛', async () => {
    const r = await read({ path: path.join(dir, 'nosuch.txt') }) as { type: string };
    expect(r.type).toBe('error');
  });
});

describe('write 工具（盲覆盖守卫）', () => {
  it('已存在但未读过的文件 → 拒绝整文件覆盖', async () => {
    const p = path.join(dir, 'guard.txt');
    writeFileSync(p, '原有重要内容');
    const r = await write({ path: p, content: '覆盖' }) as string;
    expect(r).toContain('错误');
    expect(r).toContain('尚未读取过');
    expect(r).toContain('read 工具');
    expect(readFileSync(p, 'utf-8')).toBe('原有重要内容'); // 原文未被破坏
  });

  it('read 过之后 → 允许写', async () => {
    const p = path.join(dir, 'guard.txt');
    await read({ path: p });
    const r = await write({ path: p, content: '新内容' }) as string;
    expect(r).toContain('成功写入');
    expect(readFileSync(p, 'utf-8')).toBe('新内容');
  });

  it('新文件递归建目录', async () => {
    const p = path.join(dir, 'nested', 'deep', 'new.txt');
    const r = await write({ path: p, content: 'hello' }) as string;
    expect(r).toContain('成功写入');
    expect(readFileSync(p, 'utf-8')).toBe('hello');
  });
});

describe('edit 工具', () => {
  it('文件不存在 + old_string 空 → 创建', async () => {
    const p = path.join(dir, 'created.txt');
    const r = await edit({ path: p, old_string: '', new_string: '创建内容' }) as string;
    expect(r).toContain('成功创建');
    expect(readFileSync(p, 'utf-8')).toBe('创建内容');
  });

  it('文件不存在 + old_string 非空 → 错误', async () => {
    const r = await edit({ path: path.join(dir, 'nosuch-edit.txt'), old_string: 'x', new_string: 'y' }) as string;
    expect(r).toContain('错误');
  });

  it('唯一匹配替换成功', async () => {
    const p = path.join(dir, 'edit-unique.txt');
    writeFileSync(p, 'AAA_before_BBB');
    await read({ path: p }); // 解锁盲改守卫
    const r = await edit({ path: p, old_string: 'before', new_string: 'after' }) as string;
    expect(r).toContain('成功编辑');
    expect(readFileSync(p, 'utf-8')).toBe('AAA_after_BBB');
  });

  it('多匹配无 replace_all → 拒绝；replace_all 全替换', async () => {
    const p = path.join(dir, 'edit-multi.txt');
    writeFileSync(p, 'x-a x-a x-a');
    await read({ path: p });
    const r1 = await edit({ path: p, old_string: 'x-a', new_string: 'y' }) as string;
    expect(r1).toContain('3 处匹配');
    const r2 = await edit({ path: p, old_string: 'x-a', new_string: 'y', replace_all: true }) as string;
    expect(r2).toContain('成功编辑');
    expect(readFileSync(p, 'utf-8')).toBe('y y y');
  });

  it('未找到 + 疑似带行号前缀 → 专门提示', async () => {
    const p = path.join(dir, 'edit-lineno.txt');
    writeFileSync(p, '正文内容');
    await read({ path: p });
    const r = await edit({ path: p, old_string: '  12  正文内容', new_string: 'x' }) as string;
    expect(r).toContain('行号前缀');
  });

  it('old_string === new_string → 无需修改', async () => {
    const p = path.join(dir, 'edit-same.txt');
    writeFileSync(p, '内容');
    await read({ path: p });
    const r = await edit({ path: p, old_string: '内容', new_string: '内容' }) as string;
    expect(r).toContain('相同');
  });

  it('未读过的文件 → 盲改守卫拒绝', async () => {
    const p = path.join(dir, 'edit-guard.txt');
    writeFileSync(p, '未知内容');
    const r = await edit({ path: p, old_string: '未知', new_string: 'x' }) as string;
    expect(r).toContain('尚未读取过');
  });
});

describe('bash 工具', () => {
  it('正常输出带 [cwd] 前缀', async () => {
    const r = await bash({ command: 'echo hello-bash' }) as { type: string; output: string };
    expect(r.type).toBe('bash');
    expect(r.output).toContain('[cwd:');
    expect(r.output).toContain('hello-bash');
  });

  it('非零退出码标注', async () => {
    const r = await bash({ command: 'exit 42' }) as { output: string };
    expect(r.output).toContain('[exit code: 42]');
  });

  it('stderr 合并进输出', async () => {
    const r = await bash({ command: 'echo err-msg >&2' }) as { output: string };
    expect(r.output).toContain('[stderr]');
    expect(r.output).toContain('err-msg');
  });

  it('超时整组终止 + 提示', async () => {
    const r = await bash({ command: 'sleep 10', timeout: 5 }) as { output: string };
    expect(r.output).toContain('超时');
    expect(r.output).toContain('已整组终止');
  }, 15_000);

  it('timeout 非数值 → 默认 60 不挂死（NaN 防御）', async () => {
    const r = await bash({ command: 'echo nan-guard', timeout: 'not-a-number' }) as { output: string };
    expect(r.output).toContain('nan-guard');
  });
});

describe('view 工具（图片管线）', () => {
  it('非图片扩展名 → 引导用 read', async () => {
    const r = await view({ path: path.join(dir, 'sample.txt') }) as { type: string; message: string };
    expect(r.type).toBe('error');
    expect(r.message).toContain('read');
  });

  it('真实 PNG → image 块（直传无损路径）', async () => {
    const p = path.join(dir, 'small.png');
    const png = await sharp({ create: { width: 40, height: 30, channels: 4, background: { r: 0, g: 100, b: 200, alpha: 1 } } }).png().toBuffer();
    writeFileSync(p, png);
    const r = await view({ path: p }) as { type: string; media_type: string; base64: string; size: string; path: string };
    expect(r.type).toBe('image');
    expect(r.media_type).toBe('image/png'); // 安全格式小图直传
    expect(r.base64.length).toBeGreaterThan(10);
    expect(r.size).toContain('bytes');
  });

  it('超大图 → 护栏压缩（>4096 降采样，media_type 转 jpeg）', async () => {
    const p = path.join(dir, 'huge.png');
    const big = await sharp({ create: { width: 6000, height: 4000, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
    writeFileSync(p, big);
    const r = await view({ path: p }) as { type: string; media_type: string; base64: string; size: string; width: number; height: number };
    expect(r.type).toBe('image');
    expect(r.media_type).toBe('image/jpeg'); // 重编码归一
    // 压缩结果确实是可解码且尺寸受护栏约束的图
    const decoded = await sharp(Buffer.from(r.base64, 'base64')).metadata();
    expect(decoded.width).toBeLessThanOrEqual(4096);
    expect(decoded.format).toBe('jpeg');
  }, 30_000);

  it('批次像素预算摊薄：多张共享预算自动降采样', async () => {
    const buf = await sharp({ create: { width: 80, height: 80, channels: 3, background: { r: 10, g: 200, b: 10 } } }).png().toBuffer();
    const b64 = buf.toString('base64');
    // 谎报尺寸（width/height 字段）触发摊薄；base64 是真图，重编码可执行
    const results = [
      { type: 'image', base64: b64, media_type: 'image/png', size: 'x', width: 6000, height: 6000 },
      { type: 'image', base64: b64, media_type: 'image/png', size: 'x', width: 6000, height: 6000 },
      { type: 'text', content: '非图片结果不受影响' },
    ];
    const n = await applyBatchImageBudget(results);
    expect(n).toBe(2);
    expect((results[0] as { size: string }).size).toContain('批次摊薄');
    expect((results[2] as { content: string }).content).toBe('非图片结果不受影响');
  }, 30_000);
});
