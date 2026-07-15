// 配置常量。用户可改的字段（apiBaseUrl/apiKey/model/maxTokens/contextWindow/temperature）
// 从同目录的 config.json 读取，其余为本项目内部常量。
// 配置方法：复制 config.example.json → config.json，改里面的值即可。

import { readFileSync } from 'node:fs';
import path from 'node:path';

interface UserConfig {
  apiBaseUrl?: string;
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  contextWindow?: number;
  temperature?: number;
}

function loadConfig(): UserConfig {
  try {
    return JSON.parse(readFileSync(path.join(import.meta.dirname ?? '.', '..', 'config.json'), 'utf-8'));
  } catch {
    return {}; // config.json 不存在时用下面的默认值
  }
}

const cfg = loadConfig();

// —— 用户可配置项（config.json 覆盖）——
export const API_BASE_URL = cfg.apiBaseUrl ?? 'https://open.bigmodel.cn/api/anthropic';
export const API_KEY = cfg.apiKey ?? '';
export const MODEL = cfg.model ?? 'glm-5.1';
export const MAX_TOKENS = cfg.maxTokens ?? 192000;
export const CONTEXT_WINDOW = cfg.contextWindow ?? 192000;
export const TEMPERATURE = cfg.temperature ?? 0.7;

export function getApiKey(): string {
  return API_KEY;
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

export const SKILL_DIR = 'skill';
export const SYSTEM_PROMPT = '';

// CC 风格符号 + 主色
export const SYM_USER = '❯';
export const SYM_TOOL = '⏺';
export const SYM_RESULT = '⎿';
export const SYM_THINK = '✻';
export const ACCENT = '#D97757';
