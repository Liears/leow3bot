// 配置常量。用户可改的字段（apiBaseUrl/apiKey/model/contextWindow/permissions/
// systemPrompt/thinkingBudget/webApiKey）从 ~/.leow3bot/config.json 读取，
// 其余为本项目内部常量（maxTokens/temperature/web 搜索参数等已固化为内置值，不再暴露配置）。
// 配置方法：复制 config.example.json → config.json，改里面的值即可。

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

// 权限规则：pattern 默认按前缀匹配，mode:'regex' 时按正则；reason 为命中时给模型的解释
export interface PermissionRule {
  pattern: string;
  mode?: 'prefix' | 'regex';
  reason?: string;
}
export interface PermissionsConfig {
  deny?: PermissionRule[];
  confirm?: PermissionRule[];
}

interface UserConfig {
  apiBaseUrl?: string;
  apiKey?: string;
  model?: string;
  contextWindow?: number;
  // 权限管控：deny 命中直接拒绝；confirm 命中弹交互确认（~/.leow3bot/permissions.json 存记住的允许）
  permissions?: PermissionsConfig;
  // 自定义系统提示词（可选，覆盖内置默认——身份/语言/工具约定）
  systemPrompt?: string;
  // web 工具（智谱原生 web_search / reader）
  webApiKey?: string;
  // thinking（深度思考）
  thinkingBudget?: number;
  // 子代理模型（/subagent 命令写入；缺省继承主模型 model）
  subagentModel?: string;
  // 各模型 max_tokens 上限缓存（自动学习，非用户配置面）
  modelLimits?: Record<string, number>;
}

function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(file, 'utf-8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null; // 不存在 / 损坏 / 非对象
  }
}

// 合并加载：项目根 config.json 为底、用户级 ~/.leow3bot/config.json 覆盖。
// 不用 first-match-wins——否则 /model 或 onboarding 写出的稀疏 home 文件
// （只含 model/apiKey）会遮蔽 repo config 里的 apiKey/permissions 等字段，
// 导致开发态配置静默失效、onboarding 误触发（code-review F5）。
function loadConfig(): UserConfig {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const proj = readJsonFile(path.join(here, '..', 'config.json')) ?? {};
  // 直接用 homedir() 拼，不能用 LEOW3BOT_HOME 常量（它在后面才定义，此处处于 TDZ）
  const home = readJsonFile(path.join(homedir(), '.leow3bot', 'config.json')) ?? {};
  return { ...proj, ...home } as UserConfig;
}

const cfg = loadConfig();

// —— 用户可配置项（config.json 覆盖；API_BASE_URL/API_KEY/MODEL 为 let，
//     onboarding 首次配置与 /model 切换经 applyRuntimeConfig 运行时更新）——
export const DEFAULT_API_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';
export let API_BASE_URL = cfg.apiBaseUrl ?? DEFAULT_API_BASE_URL;
export let API_KEY = cfg.apiKey ?? '';
export let MODEL = cfg.model ?? 'glm-5.1';
// 上下文窗口无查询通道（/v1/models 两端点均不带该字段，实测）——onboarding 让
// 用户手输（默认 192000），此后存 config 跟随启动
export let CONTEXT_WINDOW = cfg.contextWindow ?? 192000;

// 读改写 home config.json（保留已有字段）。损坏（JSON.parse 失败）时拒写返回
// false——静默覆盖会把用户全部配置清空（code-review F6）；写失败（权限/磁盘）
// 同样返回 false，调用方据此如实报告（F7）。
function updateHomeConfig(patch: Record<string, unknown>): boolean {
  const file = path.join(homedir(), '.leow3bot', 'config.json');
  let obj: Record<string, unknown> | null = null;
  let existed = false;
  try {
    existed = existsSync(file);
    if (existed) {
      try {
        const v = JSON.parse(readFileSync(file, 'utf-8'));
        if (v && typeof v === 'object' && !Array.isArray(v)) obj = v;
        else return false; // null/数组等异常内容 → 拒写
      } catch {
        return false; // 损坏 → 拒写（宁可不持久化，不可清空用户配置）
      }
    }
    const merged = { ...(obj ?? {}), ...patch };
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
    return true;
  } catch {
    return false; // EACCES / ENOTDIR / 磁盘满 → 调用方如实报告
  }
}

// 运行时配置更新（onboarding / /model 共用）：更新运行时值——ESM live binding
// 让 llm.ts 等模块的既有 import 即时拿到新值，零改动；并读改写 ~/.leow3bot/config.json
// 持久化。返回是否写盘成功（运行时切换总是生效，落盘失败仅影响下次启动）。
export function applyRuntimeConfig(patch: { apiBaseUrl?: string; apiKey?: string; model?: string; contextWindow?: number; subagentModel?: string | null }): boolean {
  if (patch.apiBaseUrl !== undefined) API_BASE_URL = patch.apiBaseUrl;
  if (patch.apiKey !== undefined) API_KEY = patch.apiKey;
  if (patch.model !== undefined) MODEL = patch.model;
  if (patch.contextWindow !== undefined) CONTEXT_WINDOW = patch.contextWindow;
  if (patch.subagentModel !== undefined) SUBAGENT_MODEL = patch.subagentModel;
  return updateHomeConfig(patch as Record<string, unknown>);
}

// —— max_tokens 按模型自适应（code-review F8 → 错误驱动学习）——
// 默认发 MAX_TOKENS(192000)；端点若 400 报上限（智谱格式 "限制数值范围[1,131072]"），
// llm.ts 提取上限 → setModelMaxTokens 缓存 → 重试。学到的值按模型记入 config，
// 同一模型永不复撞。
const modelLimits = new Map<string, number>(Object.entries(cfg.modelLimits ?? {}));
export function getModelMaxTokens(model: string): number {
  return modelLimits.get(model) ?? MAX_TOKENS;
}
export function setModelMaxTokens(model: string, limit: number): void {
  modelLimits.set(model, limit);
  updateHomeConfig({ modelLimits: Object.fromEntries(modelLimits) });
}

// model 是否被用户显式配置（false = 允许启动时从 /v1/models 自动探测选型）
export function hasExplicitModel(): boolean {
  return cfg.model !== undefined;
}

// —— SubAgent（设计见 docs/subagent-design.md）——
// 子代理模型：默认继承主模型（行为可预期、零配置）；/subagent 命令显式选择并
// 持久化到这里。解析顺序：agent 定义 frontmatter model > subagentModel > 继承主模型。
export let SUBAGENT_MODEL: string | null = cfg.subagentModel ?? null;
export function getSubagentModel(): string | null { return SUBAGENT_MODEL; }
export const MAX_SUBAGENT_TURNS = 25;          // 默认轮次（agent 定义可覆盖）
export const MAX_SUBAGENT_TURNS_HARD = 50;     // 轮次硬上限
export const MAX_CONCURRENT_SUBAGENTS = 3;     // 并发上限（TUI 无多路面板，多了暗处不可见）
export const SUBAGENT_REPORT_MAX_CHARS = 4000; // 报告回传上限（超出落盘，主上下文零污染）

// agent 定义扫描目录（后者覆盖前者同名；与 getSkillDirs 同构，兼容 CC 生态）
export function getAgentDirs(): string[] {
  return [
    path.join(homedir(), '.claude', 'agents'),
    path.join(LEOW3BOT_HOME, 'agents'),
    path.join(process.cwd(), '.claude', 'agents'),
  ];
}

// —— 内置固定值（原 config.json 字段，简化后固化）——
export const MAX_TOKENS = 192000;
export const TEMPERATURE = 0.7;

// thinking（深度思考，默认常开）—— glm-5.x 经 Anthropic 兼容端点需显式传 thinking 参数才会发思考流
export const THINKING_BUDGET = cfg.thinkingBudget ?? 5000;

// 权限管控自定义规则（内置 deny 规则见 permissions.ts，不依赖此配置）
export const USER_PERMISSIONS: PermissionsConfig = cfg.permissions ?? {};

// —— web 工具（智谱原生 web_search / reader 端点，与 apiKey 同平台）——
// 搜索参数为内置固定默认值；模型可经 web_search 工具参数逐次覆盖（search_engine/count/content_size）
export const WEB_SEARCH_ENGINE = 'search_std';
export const WEB_SEARCH_CONTENT_SIZE = 'medium';
export const WEB_SEARCH_COUNT = 10;
export const WEB_RESULT_MAX_CHARS = 30000;
// 智谱 web 工具固定端点（与 API_BASE_URL 的 /api/anthropic 不耦合）
export const WEB_SEARCH_URL = 'https://open.bigmodel.cn/api/paas/v4/web_search';

export function getApiKey(): string {
  return API_KEY;
}
// 按 API_BASE_URL 推断平台显示名（banner 用），未知端点回退 hostname
export function getProviderLabel(): string {
  const host = new URL(API_BASE_URL).hostname;
  if (host.includes('bigmodel')) return '智谱 BigModel';
  if (host.includes('deepseek')) return 'DeepSeek';
  if (host.includes('anthropic')) return 'Anthropic';
  if (host.includes('moonshot')) return 'Moonshot';
  if (host.includes('qwen') || host.includes('aliyun')) return '通义千问';
  return host;
}
// web 工具 key：默认复用 apiKey（智谱同 key 零配置），可在 config.json 用 webApiKey 覆盖
export function getWebApiKey(): string {
  return cfg.webApiKey || API_KEY;
}

// —— 内部常量（一般不需改）——
export const TOP_P: number | null = null;
export const TOP_K: number | null = null;
export const MAX_CONCURRENT_TOOLS = 10;
export const MAX_TOOL_RESULT_CHARS = 16000;      // read/write/skill 等工具结果上限（截断保留首尾）

// bash 输出上限（对齐 Claude Code）：默认 30000 字符，可用环境变量
// BASH_MAX_OUTPUT_LENGTH 调整（上限 150000，与 CC 的 outputLimits 一致）。
// 超限输出只保留头部 + 行数提示，完整内容落盘供 read 工具取回。
function boundedIntFromEnv(name: string, def: number, upper: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(1, n), upper);
}
export const MAX_BASH_OUTPUT_CHARS = boundedIntFromEnv('BASH_MAX_OUTPUT_LENGTH', 30000, 150000);
export const MAX_TOOL_ROUNDS = 100;
export const API_TIMEOUT = 600; // 秒
// 单次粘贴的全文进上下文阈值（字符）：超过则落盘 + 头部截断（再生配方，
// 对齐 bash/web_fetch 大输出策略，防巨量粘贴炸 scrollback 与上下文）
export const PASTE_PERSIST_CHARS = 20_000;

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
// 图片护栏（即看即释设计下分辨率/质量不再是长期成本，上限仅防病理巨图与过大请求体）
export const IMAGE_MAX_WIDTH = 4096;
export const IMAGE_MAX_HEIGHT = 4096;
export const IMAGE_TARGET_RAW_SIZE = 5_000_000; // payload 字节护栏（对齐 Anthropic 单图 5MB 上限；超限才温和降质，字节不占 token）
// 单轮 view 硬预算：即看即释的工作集以"批次有界"为前提（schema 软引导之外的执行侧约束）
export const MAX_VIEWS_PER_ROUND = 6;
// 批次像素预算：单请求所有图片的总像素上限（Qwen 28px patch → ≈15K 视觉 token，
// 实测该服务器安全线；3 张原图 ≈33K token 会挂起）。
// 批内按张数摊薄——单张独享全预算（原图直传），N 张各分 1/N（自动降采样）。
export const IMAGE_BATCH_PIXEL_BUDGET = 11_800_000;

// leow3bot 用户级 home：config / sessions / skills 都在这下面
export const LEOW3BOT_HOME = path.join(homedir(), '.leow3bot');

// skill 扫描目录（数组顺序=优先级，后者覆盖前者同名 skill）：
//   1) ~/.claude/skills      —— Claude 用户级标准（`npx skills add` 默认装这）
//   2) ~/.leow3bot/skills  —— leow3bot 自己的 home
//   3) ./.claude/skills      —— 项目级（覆盖用户级）
// 动态函数：--resume 恢复会话 chdir 后重算项目级目录（main.tsx / SessionPicker 调用）。
export function getSkillDirs(): string[] {
  return [
    path.join(homedir(), '.claude', 'skills'),
    path.join(LEOW3BOT_HOME, 'skills'),
    path.join(process.cwd(), '.claude', 'skills'),
  ];
}
// 基础系统提示词：身份 + 语言（中文思考）+ 风格，三句话。
// 工具行为约定不写在这——工具 schema 描述和运行时报错提示（截断恢复路径、
// 行号提示、守卫引导）在需要的瞬间送达，比开场白更有效。config.json 可覆盖。
const DEFAULT_SYSTEM_PROMPT =
  '你是 leow3bot，运行在用户本地终端的中文 AI 助手。' +
  '始终使用中文思考和回复（专有名词、命令、代码保留原文）。' +
  '回答简洁直接、结论先行。';

export const SYSTEM_PROMPT: string = cfg.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

// CC 风格符号 + 主色
export const SYM_USER = '❯';
export const SYM_TOOL = '⏺';
export const SYM_RESULT = '⎿';
export const SYM_THINK = '✻';
export const ACCENT = '#06B6D4';
