// 配置模块集成测试（config.ts）：加载合并语义 / 运行时写回 / 损坏防护 /
// max_tokens 自适应缓存。用 vi.resetModules + 动态 import 拿全新的 config 模块
// 实例（config 在 import 时读盘定格），每轮换 LEOW3BOT_HOME 隔离。
import { vi, describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let home = '';

beforeEach(() => {
  vi.resetModules();
  if (home) { try { rmSync(home, { recursive: true, force: true }); } catch { /* noop */ } }
  home = mkdtempSync(path.join(tmpdir(), 'leow3bot-cfg-'));
  mkdirSync(path.join(home, '.leow3bot'), { recursive: true });
  delete process.env.LEOW3BOT_API_BASE_URL;
});

// beforeEach 只清"上一个"，最后一个 home 要在 afterAll 兜底（否则每次跑泄漏一个目录）
afterAll(() => { if (home) { try { rmSync(home, { recursive: true, force: true }); } catch { /* noop */ } } });

const loadConfigModule = () => import('../../src/config.js');

const writeHomeConfig = (obj: unknown): void => {
  writeFileSync(path.join(home, '.leow3bot', 'config.json'), JSON.stringify(obj, null, 2));
};

describe('配置加载合并', () => {
  it('无任何配置 → 内置默认值', async () => {
    process.env.LEOW3BOT_HOME = home;
    const m = await loadConfigModule();
    expect(m.MODEL).toBe('glm-5.1');
    expect(m.API_KEY).toBe('');
    expect(m.API_BASE_URL).toBe(m.DEFAULT_API_BASE_URL);
    expect(m.hasExplicitModel()).toBe(false);
    expect(m.LEOW3BOT_HOME).toBe(path.join(home, '.leow3bot'));
  });

  it('home config 覆盖默认值', async () => {
    process.env.LEOW3BOT_HOME = home;
    writeHomeConfig({ apiKey: 'sk-test', model: 'glm-custom', contextWindow: 128000, thinkingBudget: 8000 });
    const m = await loadConfigModule();
    expect(m.getApiKey()).toBe('sk-test');
    expect(m.MODEL).toBe('glm-custom');
    expect(m.CONTEXT_WINDOW).toBe(128000);
    expect(m.THINKING_BUDGET).toBe(8000);
    expect(m.hasExplicitModel()).toBe(true);
  });

  it('LEOW3BOT_API_BASE_URL 环境变量优先于配置文件（测试隔离旋钮）', async () => {
    process.env.LEOW3BOT_HOME = home;
    process.env.LEOW3BOT_API_BASE_URL = 'http://127.0.0.1:9999/api/anthropic';
    writeHomeConfig({ apiBaseUrl: 'https://from-config.example.com' });
    const m = await loadConfigModule();
    expect(m.API_BASE_URL).toBe('http://127.0.0.1:9999/api/anthropic');
  });

  it('损坏的 home config → 当作不存在（不崩）', async () => {
    process.env.LEOW3BOT_HOME = home;
    writeFileSync(path.join(home, '.leow3bot', 'config.json'), '{broken json');
    const m = await loadConfigModule();
    expect(m.MODEL).toBe('glm-5.1');
  });

  it('数组/null 形态的 config → 当作不存在', async () => {
    process.env.LEOW3BOT_HOME = home;
    writeFileSync(path.join(home, '.leow3bot', 'config.json'), '[1, 2, 3]');
    const m = await loadConfigModule();
    expect(m.MODEL).toBe('glm-5.1');
  });

  it('getProviderLabel 按端点域名推断', async () => {
    process.env.LEOW3BOT_HOME = home;
    const m = await loadConfigModule();
    expect(m.getProviderLabel()).toBe('智谱 BigModel'); // 默认端点
    m.applyRuntimeConfig({ apiBaseUrl: 'https://api.deepseek.com/anthropic' });
    expect(m.getProviderLabel()).toBe('DeepSeek');
    m.applyRuntimeConfig({ apiBaseUrl: 'https://unknown-llm.example.com/v1' });
    expect(m.getProviderLabel()).toBe('unknown-llm.example.com');
  });
});

describe('applyRuntimeConfig 运行时写回', () => {
  it('运行时更新 live binding + 读改写保留既有字段', async () => {
    process.env.LEOW3BOT_HOME = home;
    writeHomeConfig({ apiKey: 'sk-keep', contextWindow: 64000 });
    const m = await loadConfigModule();
    const ok = m.applyRuntimeConfig({ model: 'glm-new', contextWindow: 96000 });
    expect(ok).toBe(true);
    expect(m.MODEL).toBe('glm-new');        // live binding 即时生效
    expect(m.CONTEXT_WINDOW).toBe(96000);
    const onDisk = JSON.parse(readFileSync(path.join(home, '.leow3bot', 'config.json'), 'utf-8'));
    expect(onDisk.apiKey).toBe('sk-keep');  // 未触碰的字段保留
    expect(onDisk.model).toBe('glm-new');
  });

  it('写盘落在隔离 HOME 内（不污染真实 home）', async () => {
    process.env.LEOW3BOT_HOME = home;
    const m = await loadConfigModule();
    m.applyRuntimeConfig({ model: 'isolated-model' });
    const file = path.join(home, '.leow3bot', 'config.json');
    expect(JSON.parse(readFileSync(file, 'utf-8')).model).toBe('isolated-model');
  });

  it('home config 损坏 → 拒写返回 false（不清空用户配置）', async () => {
    process.env.LEOW3BOT_HOME = home;
    writeFileSync(path.join(home, '.leow3bot', 'config.json'), '{broken');
    const m = await loadConfigModule();
    expect(m.applyRuntimeConfig({ model: 'x' })).toBe(false);
    expect(readFileSync(path.join(home, '.leow3bot', 'config.json'), 'utf-8')).toBe('{broken'); // 原文不动
  });

  it('subagentModel 显式清除（null）', async () => {
    process.env.LEOW3BOT_HOME = home;
    writeHomeConfig({ subagentModel: 'glm-sub' });
    const m = await loadConfigModule();
    expect(m.getSubagentModel()).toBe('glm-sub');
    m.applyRuntimeConfig({ subagentModel: null });
    expect(m.getSubagentModel()).toBeNull();
  });
});

describe('max_tokens 按模型自适应缓存', () => {
  it('未知模型 → MAX_TOKENS 默认', async () => {
    process.env.LEOW3BOT_HOME = home;
    const m = await loadConfigModule();
    expect(m.getModelMaxTokens('never-seen-model')).toBe(m.MAX_TOKENS);
  });

  it('setModelMaxTokens 缓存 + 持久化，重载生效', async () => {
    process.env.LEOW3BOT_HOME = home;
    const m1 = await loadConfigModule();
    m1.setModelMaxTokens('glm-test', 131072);
    expect(m1.getModelMaxTokens('glm-test')).toBe(131072);
    const onDisk = JSON.parse(readFileSync(path.join(home, '.leow3bot', 'config.json'), 'utf-8'));
    expect(onDisk.modelLimits['glm-test']).toBe(131072);
    // 重载（模拟下次启动）
    vi.resetModules();
    const m2 = await loadConfigModule();
    expect(m2.getModelMaxTokens('glm-test')).toBe(131072);
  });

  it('config 里预置的 modelLimits 生效', async () => {
    process.env.LEOW3BOT_HOME = home;
    writeHomeConfig({ modelLimits: { 'preset-model': 8192 } });
    const m = await loadConfigModule();
    expect(m.getModelMaxTokens('preset-model')).toBe(8192);
  });
});
