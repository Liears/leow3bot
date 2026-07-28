// 配置常量。用户可改的字段（apiBaseUrl/apiKey/model/maxTokens/contextWindow/temperature）
// 从同目录的 config.json 读取，其余为本项目内部常量。
// 配置方法：复制 config.example.json → config.json，改里面的值即可。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

interface UserConfig {
  apiBaseUrl?: string;
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  contextWindow?: number;
  temperature?: number;
  // web 工具（智谱原生 web_search / reader）
  webSearchEngine?: string;
  webSearchContentSize?: string;
  webSearchCount?: number;
  webResultMaxChars?: number;
  webApiKey?: string;
  // thinking（深度思考）
  thinkingBudget?: number;
}

function loadConfig(): UserConfig {
  // 1. 用户级 ~/.leow3bot/config.json（标准位置，开发/安装都改这）
  //    注意：直接用 homedir() 拼，不能用 LEOW3BOT_HOME 常量（它在后面才定义，此处处于 TDZ）
  try {
    return JSON.parse(readFileSync(path.join(homedir(), '.leow3bot', 'config.json'), 'utf-8'));
  } catch {}
  // 2. 项目 config.json（fallback：兼容旧开发态/未迁移场景）
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(path.join(here, '..', 'config.json'), 'utf-8'));
  } catch {}
  return {}; // 都不存在时用下面的默认值
}

const cfg = loadConfig();

// —— 用户可配置项（config.json 覆盖）——
export const API_BASE_URL = cfg.apiBaseUrl ?? 'https://open.bigmodel.cn/api/anthropic';
export const API_KEY = cfg.apiKey ?? '';
export const MODEL = cfg.model ?? 'glm-5.1';
export const MAX_TOKENS = cfg.maxTokens ?? 192000;
export const CONTEXT_WINDOW = cfg.contextWindow ?? 192000;
export const TEMPERATURE = cfg.temperature ?? 0.7;

// thinking（深度思考，默认常开）—— glm-5.x 经 Anthropic 兼容端点需显式传 thinking 参数才会发思考流
export const THINKING_BUDGET = cfg.thinkingBudget ?? 5000;

// —— web 工具配置（智谱原生 web_search / reader 端点，与 apiKey 同平台）——
export const WEB_SEARCH_ENGINE = cfg.webSearchEngine ?? 'search_std';
export const WEB_SEARCH_CONTENT_SIZE = cfg.webSearchContentSize ?? 'medium';
export const WEB_SEARCH_COUNT = cfg.webSearchCount ?? 10;
export const WEB_RESULT_MAX_CHARS = cfg.webResultMaxChars ?? 30000;
// 智谱 web 工具固定端点（与 API_BASE_URL 的 /api/anthropic 不耦合）
export const WEB_SEARCH_URL = 'https://open.bigmodel.cn/api/paas/v4/web_search';

export function getApiKey(): string {
  return API_KEY;
}
// web 工具 key：默认复用 apiKey（智谱同 key 零配置），可在 config.json 用 webApiKey 覆盖
export function getWebApiKey(): string {
  return cfg.webApiKey || API_KEY;
}

// —— 内部常量（一般不需改）——
export const TOP_P: number | null = null;
export const TOP_K: number | null = null;
export const MAX_CONCURRENT_TOOLS = 10;
export const MAX_TOOL_RESULT_CHARS = 8000;
export const MAX_TOOL_ROUNDS = 100;
export const API_TIMEOUT = 600; // 秒

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
export const IMAGE_MAX_WIDTH = 2000;
export const IMAGE_MAX_HEIGHT = 2000;
export const IMAGE_TARGET_RAW_SIZE = 3_750_000;

// leow3bot 用户级 home：config / sessions / skills 都在这下面
export const LEOW3BOT_HOME = path.join(homedir(), '.leow3bot');

// skill 扫描目录（数组顺序=优先级，后者覆盖前者同名 skill）：
//   1) ~/.claude/skills      —— Claude 用户级标准（`npx skills add` 默认装这）
//   2) ~/.leow3bot/skills  —— leow3bot 自己的 home
//   3) ./.claude/skills      —— 项目级（覆盖用户级）
export const SKILL_DIRS = [
  path.join(homedir(), '.claude', 'skills'),
  path.join(LEOW3BOT_HOME, 'skills'),
  path.join(process.cwd(), '.claude', 'skills'),
];
export const SYSTEM_PROMPT = '';

// CC 风格符号 + 主色
export const SYM_USER = '❯';
export const SYM_TOOL = '⏺';
export const SYM_RESULT = '⎿';
export const SYM_THINK = '✻';
export const ACCENT = '#06B6D4';
