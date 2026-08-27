// 工具注册表 + 实现（移植 tools.py）。sharp 替代 PIL；ask 异步化（Input resolve）。

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { IMAGE_EXTENSIONS, IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT, IMAGE_TARGET_RAW_SIZE, MAX_BASH_OUTPUT_CHARS } from './config.js';
import { persistToolOutput } from './lib/persist.js';
import { getSkillPrompt, SKILLS_REGISTRY } from './skills.js';
import { commit, setPhase, setAskResolver } from './store.js';
import { searchWeb, readUrl } from './websearch.js';

const execAsync = promisify(exec);

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: { type: string; properties: Record<string, unknown>; required: string[] };
}
export interface ToolDef {
  function: (args: Record<string, unknown>) => Promise<unknown> | unknown;
  concurrencySafe: boolean;
  schema: ToolSchema;
}

// ============================================================
// 工具实现
// ============================================================

// bash 每次都在全新 shell 中执行，工作目录 = 当前进程 cwd（--resume 恢复会话会切换，
// 所以动态读取而非启动时固化）。输出带 [cwd] 前缀 + 工具描述声明，
// 避免模型因不知道当前目录而乱 cd / find / 全盘搜索。
//
// 超长输出策略（对齐 Claude Code）：只保留头部 + 告诉模型截掉了多少行，
// 完整内容落盘到系统临时目录（lib/persist.ts，与 web_fetch 共用），
// tool_result 带路径——模型需要时用 read 工具取回，截断只是"默认展示窗口"。

async function runBash(command: string, timeoutSec?: number) {
  const cwdTag = `[cwd: ${process.cwd()}]`;
  // 参数防御 + 钳制 5-300s，默认 60s。NaN（模型传非数值）会导致 exec 无超时挂死，必须挡
  const n = Number(timeoutSec);
  const sec = Number.isFinite(n) ? n : 60;
  const timeoutMs = Math.min(300, Math.max(5, Math.floor(sec))) * 1000;
  const finish = (out: string) => {
    let body = out;
    if (body.length > MAX_BASH_OUTPUT_CHARS) {
      const remainingLines = body.slice(MAX_BASH_OUTPUT_CHARS).split('\n').length; // 被截掉的行数
      const saved = persistToolOutput('bash-out', body);
      body =
        body.slice(0, MAX_BASH_OUTPUT_CHARS) +
        `\n\n... [${remainingLines} lines truncated] ...` +
        (saved ? `\n完整输出已保存: ${saved}（可用 read 工具读取）` : '');
    }
    return { type: 'bash' as const, command, output: body };
  };
  try {
    const { stdout, stderr } = await execAsync(command, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    let out = stdout;
    if (stderr) out += '\n[stderr] ' + stderr;
    return finish(cwdTag + '\n' + (out || '(无输出)'));
  } catch (e: unknown) {
    const err = e as { killed?: boolean; stdout?: string; stderr?: string; code?: number; message?: string };
    if (err.killed) return { type: 'bash' as const, command, output: cwdTag + `\n错误：命令执行超时（${timeoutMs / 1000}秒，可用 timeout 参数延长至最多 300 秒，或用 nohup ... & 转后台）` };
    let out = err.stdout || '';
    if (err.stderr) out += '\n[stderr] ' + err.stderr;
    if (err.code) out += `\n[exit code: ${err.code}]`;
    return finish(cwdTag + '\n' + (out || err.message || String(e)));
  }
}

export async function compressImage(raw: Buffer, ext: string): Promise<{ data: Buffer; mediaType: string }> {
  const img = sharp(raw, { failOn: 'none' });
  const meta = await img.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const needResize = width > IMAGE_MAX_WIDTH || height > IMAGE_MAX_HEIGHT;
  const needCompress = raw.length > IMAGE_TARGET_RAW_SIZE;
  const mtOf = (e: string) => `image/${e === '.jpg' || e === '.jpeg' ? 'jpeg' : e.slice(1)}`;
  // 即看即释：图片只在被消费的当轮占上下文，分辨率/质量不再是长期成本——
  // 两个上限均为护栏（防病理巨图撑爆窗口、防请求体过大），普通图片原样直传零损耗，
  // 保证观察记录（永久资产）的细节质量。
  if (!needResize && !needCompress) return { data: raw, mediaType: mtOf(ext) };

  let pipeline = img;
  if (needResize) {
    const ratio = Math.min(IMAGE_MAX_WIDTH / width, IMAGE_MAX_HEIGHT / height);
    pipeline = img.resize(Math.round(width * ratio), Math.round(height * ratio), { fit: 'inside' });
  }
  // 超 payload 护栏：温和降质（q90→q80，字节不占 token 但质量损伤观察，尽量轻）；
  // 仍超才减半尺寸（仅病理图走到这里）
  for (const q of [90, 80] as const) {
    const d = await pipeline.clone().flatten().jpeg({ quality: q }).toBuffer();
    if (d.length <= IMAGE_TARGET_RAW_SIZE) return { data: d, mediaType: 'image/jpeg' };
  }
  const d = await pipeline
    .resize(Math.max(1, Math.round(width / 2)), Math.max(1, Math.round(height / 2)), { fit: 'inside' })
    .flatten().jpeg({ quality: 85 }).toBuffer();
  return { data: d, mediaType: 'image/jpeg' };
}

// 本会话 read/edit/write 过的文件（绝对路径）。write 盲覆盖守卫用：
// 已存在但从未读过的文件不允许直接 write（对齐 CC readFileState）。
const READ_KNOWN_FILES = new Set<string>();

// read：读取文本文件，支持 offset/limit 行范围分页（对齐 CC FileReadTool）。
// 输出带行号（cat -n 风格，便于 edit 协调与错误定位）；页内容受字符预算约束
// （单行过长/页超预算时提前截断并明确提示——不让执行器截断"撒谎"）。
async function readFile(p: string, offset = 1, limit?: number) {
  const ext = path.extname(p).toLowerCase();
  if (IMAGE_EXTENSIONS.includes(ext)) {
    return { type: 'error' as const, message: `"${p}" 是图片文件（${ext}），请使用 view 工具查看图片` };
  }
  // 参数防御：模型可能传非数值（宽松端点不严格校验 schema），NaN 会让 slice 静默返回空
  const offNum = Number(offset);
  const limNum = limit === undefined ? undefined : Number(limit);
  if (!Number.isFinite(offNum) || (limNum !== undefined && !Number.isFinite(limNum))) {
    return { type: 'error' as const, message: `offset/limit 参数无效（offset=${JSON.stringify(offset)}, limit=${JSON.stringify(limit)}），必须是数字` };
  }
  try {
    const st = statSync(p);
    const explicit = offNum !== 1 || limNum !== undefined; // 显式分页 = 模型有意识定向读
    if (st.size > 100 * 1024 * 1024) {
      return { type: 'error' as const, message: `文件过大（${(st.size / 1024 / 1024).toFixed(0)} MB），read 无法处理。请用 bash 的 head -c/sed -n/grep 定向读取` };
    }
    if (st.size > 10 * 1024 * 1024 && !explicit) {
      return { type: 'error' as const, message: `文件较大（${(st.size / 1024 / 1024).toFixed(1)} MB）。请用 offset/limit 分段读取（如 offset=1&limit=200），或 bash 的 sed -n/grep 定向读取` };
    }
    const content = await fsReadFile(p, 'utf-8');
    const lines = content.split('\n');
    const total = lines.length;
    const pageSize = Math.max(1, Math.floor(limNum ?? 200)); // limit ≤ 0 钳制为 1，防空页死循环
    const start = Math.max(0, Math.floor(offNum) - 1);
    if (start >= total) {
      return { type: 'text' as const, content: `[offset=${offNum} 超出文件总行数 ${total}，请用较小的 offset]` };
    }
    const page = lines.slice(start, start + pageSize);
    const width = String(total).length;
    const MAX_PAGE_CHARS = 14000; // 页字符预算（留余量给续读提示，不触发执行器 16K 截断）
    const out: string[] = [];
    let chars = 0;
    let shown = 0;
    for (let i = 0; i < page.length; i++) {
      const line = `${String(start + i + 1).padStart(width)}  ${page[i]}`;
      if (chars + line.length + 1 > MAX_PAGE_CHARS) {
        if (shown === 0) {
          // 首行即超预算（单行过长如 minified 文件）：截断显示该行片段并标注，
          // 不留空页（空页 + 无效的"更小 limit"提示会让模型陷入重试循环）
          out.push(line.slice(0, MAX_PAGE_CHARS) + ` …[第 ${start + 1} 行单行过长（${page[i].length} 字符），已截断显示；可用 bash sed -n '${start + 1}p' 取整行]`);
          shown = 1;
        }
        break;
      }
      out.push(line);
      chars += line.length + 1;
      shown++;
    }
    let text = out.join('\n');
    const lastShown = start + shown; // 实际展示到的行号
    if (shown < page.length) {
      text += `\n\n[本页在第 ${lastShown} 行截断（单行过长或超页字符预算），可用 offset=${lastShown + 1} 与更小的 limit 续读]`;
    } else if (start + pageSize < total) {
      text += `\n\n[已读第 ${start + 1}-${lastShown} 行，共 ${total} 行；继续请用 offset=${lastShown + 1}]`;
    }
    READ_KNOWN_FILES.add(path.resolve(p));
    return { type: 'text' as const, content: text };
  } catch (e) {
    return { type: 'error' as const, message: `错误：${(e as Error).message}` };
  }
}

// view：查看图片（视觉输入）。压缩限尺寸后以 image 块返回（上限 2000×2000，
// 对齐 CC 的 ingest 约束）。后续图片生命周期管理（热/冷分层、驱逐）锚定本工具。
async function viewImage(p: string) {
  const ext = path.extname(p).toLowerCase();
  if (!IMAGE_EXTENSIONS.includes(ext)) {
    return { type: 'error' as const, message: `"${p}" 不是图片文件（${ext || '无扩展名'}），请使用 read 工具读取文本` };
  }
  try {
    const data = await fsReadFile(p);
    const { data: compressed, mediaType } = await compressImage(data, ext);
    const b64 = compressed.toString('base64');
    const size = `${data.length} → ${compressed.length} bytes` + (compressed.length !== data.length ? ' (压缩后)' : '');
    // output 字段供 UI ⎿ 行摘要显示（summarizeResult 优先取 output，无则 JSON.stringify 兜底会露 base64）
    return { type: 'image' as const, output: `已加载图片 ${path.basename(p)}（${size}）`, path: p, media_type: mediaType, base64: b64, size };
  } catch (e) {
    return { type: 'error' as const, message: `错误：${(e as Error).message}` };
  }
}

async function writeFile(p: string, content: string) {
  try {
    // 盲覆盖守卫（对齐 CC readFileState）：已存在但本会话从未 read/edit/write 过的文件，
    // 不允许直接整文件覆盖——防止模型没读过就重写、摧毁未知内容。先 read 确认后再 write。
    if (existsSync(p) && !READ_KNOWN_FILES.has(path.resolve(p))) {
      return `错误：文件已存在且本会话尚未读取过 ${p}。为防止覆盖未知内容，请先用 read 工具读取确认后再 write（局部修改建议用 edit）`;
    }
    await mkdir(path.dirname(p) || '.', { recursive: true });
    await fsWriteFile(p, content, 'utf-8');
    READ_KNOWN_FILES.add(path.resolve(p)); // 自己写的文件内容已知
    return `成功写入 ${p}（${content.length} 字符）`;
  } catch (e) {
    return `错误：${(e as Error).message}`;
  }
}

async function editFile(p: string, oldString: string, newString: string, replaceAll = false) {
  if (oldString === newString) return '错误：old_string 和 new_string 相同，无需修改';
  if (!existsSync(p)) {
    if (oldString === '') {
      await mkdir(path.dirname(p) || '.', { recursive: true });
      await fsWriteFile(p, newString, 'utf-8');
      return `成功创建 ${p}（${newString.length} 字符）`;
    }
    return `错误：文件不存在 ${p}`;
  }
  const content = await fsReadFile(p, 'utf-8');
  const count = content.split(oldString).length - 1;
  if (count === 0) {
    // read 输出带行号前缀，弱模型可能把行号带进 old_string——检测并提示
    if (/^\s*\d+\s{2}/.test(oldString)) {
      return '错误：未找到要替换的文本，且 old_string 疑似含 read 输出的行号前缀（如 "  123  "）——old_string 必须是文件原文，不含行号';
    }
    return '错误：未找到要替换的文本';
  }
  if (count > 1 && !replaceAll) return `错误：找到 ${count} 处匹配，请提供更多上下文或设置 replace_all=true`;
  const newContent = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
  await fsWriteFile(p, newContent, 'utf-8');
  READ_KNOWN_FILES.add(path.resolve(p)); // edit 成功 = 已知文件内容
  return `成功编辑 ${p}（替换 ${replaceAll ? count : 1} 处）`;
}

function runSkill(name: string, args = '') {
  const prompt = getSkillPrompt(name, args);
  if (prompt === null) {
    const available = SKILLS_REGISTRY.size ? [...SKILLS_REGISTRY.keys()].join(', ') : '无';
    return `错误：未找到 skill '${name}'。可用 skills: ${available}`;
  }
  // 锚定 skill 目录（对齐 Claude Code 的 "Base directory for this skill"）。
  // 没有这行，正文里的相对路径（scripts/xxx.py、references/）无从解析，模型会去 find / 全盘找。
  const baseDir = SKILLS_REGISTRY.get(name)?.path;
  const anchor = baseDir ? `\nBase directory for this skill: ${path.dirname(baseDir)}` : '';
  return `[Skill: ${name}]${anchor}\n\n${prompt}`;
}

// ask：异步（Input resolve）。把 Python 阻塞 input() 异步化为 store askResolver。
async function askUser(question: string): Promise<string> {
  commit({ kind: 'system', text: `❓ ${question}`, tone: 'muted' });
  setPhase('ask_pending');
  return new Promise<string>(resolve => setAskResolver(resolve));
}

// ============================================================
// 注册表
// ============================================================

export const TOOLS_REGISTRY: Record<string, ToolDef> = {
  bash: {
    function: (a) => runBash(a.command as string, a.timeout as number | undefined),
    concurrencySafe: false,
    schema: {
      name: 'bash',
      description: '在本地执行 shell 命令并返回输出。注意：工作目录为当前会话目录（见输出开头的 [cwd]；--resume 恢复会话时会切换到会话对应目录；每次调用都是全新 shell，cd 不会跨调用保留），请使用绝对路径或相对当前目录的路径。长耗时命令（脚本/训练/安装）请传 timeout（秒，5-300，默认 60）；超过 300 秒的用 nohup ... & 转后台',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令' },
          timeout: { type: 'number', description: '超时秒数（5-300，默认 60）。长耗时命令按预估耗时设置' },
        },
        required: ['command'],
      },
    },
  },
  read: {
    function: (a) => readFile(a.path as string, a.offset as number | undefined, a.limit as number | undefined),
    concurrencySafe: true,
    schema: {
      name: 'read',
      description: '读取文本文件内容（输出带行号）。支持行范围分页：offset=起始行（从 1 开始，默认 1）、limit=读取行数（默认 200）；未读完会提示用 offset 续读。图片文件请用 view 工具查看',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          offset: { type: 'number', description: '起始行号（从 1 开始，默认 1）' },
          limit: { type: 'number', description: '读取行数（默认 200；未读完会提示续读 offset）' },
        },
        required: ['path'],
      },
    },
  },
  view: {
    function: (a) => viewImage(a.path as string),
    concurrencySafe: true,
    schema: {
      name: 'view',
      description: '查看图片文件（png/jpg/jpeg/gif/webp/bmp）以视觉输入返回。多张图片时建议每批 ≤5 张（大批量会撑大单次请求）。被释放的图片不要凭记忆描述细节——需要确认时重新 view。文本文件请用 read 工具读取',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string', description: '图片文件路径' } },
        required: ['path'],
      },
    },
  },
  edit: {
    function: (a) => editFile(a.path as string, a.old_string as string, a.new_string as string, a.replace_all as boolean | undefined),
    concurrencySafe: false,
    schema: {
      name: 'edit',
      description: '对文件执行精确的文本替换。old_string 必须在文件中唯一（除非 replace_all=true）。文件不存在且 old_string 为空字符串时可创建新文件（等价 write）。',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          old_string: { type: 'string', description: '要替换的文本' },
          new_string: { type: 'string', description: '替换后的文本' },
          replace_all: { type: 'boolean', description: '替换所有匹配（默认 false）' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  write: {
    function: (a) => writeFile(a.path as string, a.content as string),
    concurrencySafe: false,
    schema: {
      name: 'write',
      description: '将内容写入指定路径的文件',
      input_schema: { type: 'object', properties: { path: { type: 'string', description: '文件路径' }, content: { type: 'string', description: '要写入的内容' } }, required: ['path', 'content'] },
    },
  },
  skill: {
    function: (a) => runSkill(a.name as string, a.args as string | undefined),
    concurrencySafe: true, // 纯读取（注册表查询 + 文本替换），无副作用，可与 read 等并行
    schema: {
      name: 'skill',
      description: '执行指定名称的 skill，返回 skill 的详细指引。可用 skill 列表见系统提示。',
      input_schema: { type: 'object', properties: { name: { type: 'string', description: 'skill 名称' }, args: { type: 'string', description: '可选参数，如文件路径' } }, required: ['name'] },
    },
  },
  ask: {
    function: (a) => askUser(a.question as string),
    concurrencySafe: false,
    schema: {
      name: 'ask',
      description: '向用户提问，等待用户回复后继续。遇到不确定的问题、需要用户确认或选择时使用。',
      input_schema: { type: 'object', properties: { question: { type: 'string', description: '要问用户的问题' } }, required: ['question'] },
    },
  },
  web_search: {
    function: (a) =>
      searchWeb(a.query as string, {
        count: a.count as number | undefined,
        search_engine: a.search_engine as string | undefined,
        content_size: a.content_size as string | undefined,
        recency: a.recency as string | undefined,
        domain_filter: a.domain_filter as string | undefined,
      }),
    concurrencySafe: true,
    schema: {
      name: 'web_search',
      description: '联网搜索（智谱 web_search）。返回网页标题、URL、摘要、来源。需要最新信息、时事、或知识截止之后的内容时使用。回答末尾必须用 markdown 链接引用来源。',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索内容（≤70 字符）' },
          count: { type: 'integer', description: '返回条数（1-50，默认 10）' },
          search_engine: { type: 'string', enum: ['search_std', 'search_pro', 'search_pro_sogou', 'search_pro_quark'], description: '搜索引擎（默认 search_std；查中文资讯可用 search_pro_sogou/search_pro_quark）' },
          content_size: { type: 'string', enum: ['medium', 'high'], description: 'medium=摘要(省token)，high=详细（默认 medium）' },
          recency: { type: 'string', enum: ['noLimit', 'oneDay', 'oneWeek', 'oneMonth', 'oneYear'], description: '时间范围过滤（默认 noLimit）' },
          domain_filter: { type: 'string', description: '白名单域名，仅返回指定站点结果' },
        },
        required: ['query'],
      },
    },
  },
  web_fetch: {
    function: (a) => readUrl(a.url as string),
    concurrencySafe: true,
    schema: {
      name: 'web_fetch',
      description: '抓取指定 URL 的网页内容（纯客户端 fetch + HTML→markdown，返回原始正文，不做摘要）。已知具体网址、需读取其内容时使用。跨域重定向会提示用新 URL 重调。',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要读取的网页 URL（http/https）' },
        },
        required: ['url'],
      },
    },
  },
};

export const TOOLS_SCHEMAS: ToolSchema[] = Object.values(TOOLS_REGISTRY).map(t => t.schema);

/** 运行时移除工具（如 web_search 探测不可用）：删注册表 + 原地 splice schema 数组
 * （TOOLS_SCHEMAS 被 agent 按引用每轮使用，splice 后立即生效）。 */
export function disableTool(name: string): boolean {
  if (!(name in TOOLS_REGISTRY)) return false;
  delete TOOLS_REGISTRY[name];
  const i = TOOLS_SCHEMAS.findIndex(s => s.name === name);
  if (i >= 0) TOOLS_SCHEMAS.splice(i, 1);
  return true;
}
