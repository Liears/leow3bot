// SubAgent 加载器（克隆 skills.ts 模式）。内置 explore + 扫描生态目录的 md 文件
// （CC 兼容：一文件一代理，frontmatter name/description/tools/model/maxTurns，
// 正文 = 子代理 system prompt）。同名覆盖顺序：项目级 > ~/.leow3bot > ~/.claude > 内置。
// 设计与文风规则见 docs/subagent-design.md §4。

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

export interface AgentDef {
  name: string;
  description: string;      // 路由信号：身份+能力+触发条件，平实风（文风规则见设计文档 §4.5）
  content: string;          // system prompt 正文
  path: string;             // 定义来源（内置为 builtin:<name>）
  tools?: string[];         // 工具白名单（缺省 = 全量 − subagent − ask）
  model?: string;           // 模型 id（缺省：/subagent 配置 > 继承主模型）
  maxTurns?: number;        // 轮次上限（缺省 MAX_SUBAGENT_TURNS，硬上限钳制）
  reportMarker?: string;    // 报告结构契约：done 的最终输出须含此标记（如 "## 概览"），
                            // 缺失按未完成处理——防"进度旁白碰巧结束回合"伪装成报告
  builtin?: boolean;
}

export const AGENTS_REGISTRY = new Map<string, AgentDef>();

export function loadAgents(dirs: string[]): void {
  AGENTS_REGISTRY.clear();
  // 内置先行，用户/项目级同名覆盖（v1 内置仅 explore，见设计文档 §4.4）
  for (const a of BUILTIN_AGENTS) AGENTS_REGISTRY.set(a.name, a);
  for (const dir of dirs) loadAgentsFromDir(dir);
}

function loadAgentsFromDir(dir: string): void {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
  // CC 生态格式：<dir>/<name>.md（顶层一文件一代理；name 以 frontmatter 为准，
  // 缺失回退文件名）。缺 description 的文件当作文档跳过（对齐 CC 行为）。
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.md')) continue;
    const p = path.join(dir, entry);
    if (!statSync(p).isFile()) continue;
    loadAgentFile(p, entry.replace(/\.md$/, ''));
  }
}

function loadAgentFile(p: string, fallback: string): void {
  let raw: string;
  try { raw = readFileSync(p, 'utf-8'); } catch { return; }
  const { data, content } = matter(raw);
  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : fallback;
  if (typeof data.description !== 'string' || !data.description.trim()) return;
  const maxTurns = Number(data.maxTurns);
  AGENTS_REGISTRY.set(name, {
    name,
    description: data.description.trim(),
    content: content.trim(),
    path: p,
    tools: Array.isArray(data.tools) ? data.tools.map(String) : undefined,
    model: typeof data.model === 'string' && data.model.trim() ? data.model.trim() : undefined,
    maxTurns: Number.isFinite(maxTurns) && maxTurns > 0 ? Math.floor(maxTurns) : undefined,
    reportMarker: typeof data.reportMarker === 'string' && data.reportMarker.trim() ? data.reportMarker.trim() : undefined,
  });
}

// 系统提示词菜单（对齐 getSkillListing）：名字做快速匹配，description 做细粒度消歧。
// description 常驻每轮请求——定义者须自行保持简短（文风规则）。
export function getAgentListing(): string {
  if (!AGENTS_REGISTRY.size) return '';
  const lines = ['可委派的子代理（subagent 工具，独立上下文，只返回报告；独立的并行任务一轮可发多个）:'];
  for (const a of AGENTS_REGISTRY.values()) lines.push(`  - ${a.name}: ${a.description}`);
  return lines.join('\n');
}

// ============================================================
// 内置定义（v1 仅 explore；analyst/reviewer/researcher 走示例文件，见 docs/agents-examples/）
// ============================================================

const EXPLORE_AGENT: AgentDef = {
  name: 'explore',
  description: '只读搜索代理：广度扇出搜索——扫描大量文件、定位代码与文档、收集摘录，返回全局概览与候选位置清单（路径:行号 + 是否实读标注）。只定位，不审查。',
  path: 'builtin:explore',
  tools: ['read', 'view', 'bash', 'skill', 'web_search', 'web_fetch'],
  reportMarker: '## 概览',
  builtin: true,
  content: `你是 leow3bot 的只读侦察子代理，为主对话测绘领域地图：全局概览、分布、候选位置。主对话将根据你的报告亲自精读关键处——你的职责是让精读不迷路，不是替它下结论。

## 铁律
- 只读：不得创建、修改、删除任何文件。bash 中禁止重定向写入（>、>>、tee）、touch/rm/mv/cp/mkdir/sed -i 等写操作——你只搜索和阅读
- 诚实标注：没读过就是没读过——grep/文件名命中只能报告为「⚑仅命中未读」，禁止描述未读文件的内容、禁止根据文件名或 import 推断内容；标「✓已读确认」的必须真的 read 过
- 进度旁白不得结束回合：任务未完成时，每轮输出必须以工具调用收尾——绝不要输出「继续第 X 页」这类叙述后就停止；进度感想写进思考，不写成正文
- 自主完成：你无法向用户提问。信息不足就换角度扩大搜索，仍不足就在报告中如实说明缺口，不要编造
- 报告用中文（代码、命令、专有名词保留原文）

## 搜索方法
- 多角度关键词：中英文、驼峰/下划线、缩写/全称都试
- 先用 bash 的 grep -rn / find / ls 定位，再 read 关键文件确认
- 二进制格式（word/pdf 等）用 skill 工具获取抽取方法，再经 bash 执行
- 顺线索走：import → 定义处；调用处 → 被调用者
- 广度优先：预算优先花在覆盖更多位置上；判断相关性读开头几十行即可，读深留给主对话的精读
- 收窄输出：grep 加 -l/-c/head，别整文件 cat——大输出对你自己的上下文也是负担
- 信息充分即收队：关键问题已有答案、继续搜不再产生新信息时停止

## 报告格式（你的唯一交付物，主对话只能看到它）
最终报告必须以「## 概览」行开头——这是结构契约，缺失会被系统判为未完成。
## 概览
（范围多大、分成几块、各块是什么——几行勾勒地图）
## 候选位置
- 路径:行号 — 相关性一句话 〔✓已读确认｜⚑仅命中未读〕
（问题简单到能直接回答时，用「答案」一节代替本节，同样标注证据等级）
## 覆盖与缺口
- 搜了哪些位置/关键词；哪些没查到、不确定、超出范围

目标 500-1000 字，硬上限 4000 字符。报告必须自包含——主对话看不到你的任何中间过程。`,
};

export const BUILTIN_AGENTS: AgentDef[] = [EXPLORE_AGENT];
