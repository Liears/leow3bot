// 工具注册表 + 实现（移植 tools.py）。sharp 替代 PIL；ask 异步化（Input resolve）。

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { IMAGE_EXTENSIONS, IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT, IMAGE_TARGET_RAW_SIZE, MAX_BASH_OUTPUT_CHARS } from './config.js';
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
// 完整内容落盘到系统临时目录，tool_result 带路径——模型需要时用 read 工具取回，
// 截断只是"默认展示窗口"，信息不丢失。
const BASH_OUT_DIR = path.join(
  tmpdir(),
  `leow3bot-${typeof process.getuid === 'function' ? process.getuid() : 0}`,
); // /tmp/leow3bot-{uid}/，多用户共享 /tmp 防权限冲突（对齐 CC 的 claude-{uid}）

// 落盘时顺带清理超过 24h 的旧输出文件（WSL2 的 /tmp 不随重启清理，防目录无限增长）
function saveBashOutput(full: string): string {
  try {
    mkdirSync(BASH_OUT_DIR, { recursive: true });
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const f of readdirSync(BASH_OUT_DIR)) {
      const fp = path.join(BASH_OUT_DIR, f);
      try { if (statSync(fp).mtimeMs < cutoff) unlinkSync(fp); } catch { /* noop */ }
    }
    const fp = path.join(BASH_OUT_DIR, `bash-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    writeFileSync(fp, full, 'utf-8');
    return fp;
  } catch { return ''; } // 落盘失败不阻断返回（仅无取回路径）
}

async function runBash(command: string) {
  const cwdTag = `[cwd: ${process.cwd()}]`;
  const finish = (out: string) => {
    let body = out;
    if (body.length > MAX_BASH_OUTPUT_CHARS) {
      const remainingLines = body.slice(MAX_BASH_OUTPUT_CHARS).split('\n').length; // 被截掉的行数
      const saved = saveBashOutput(body);
      body =
        body.slice(0, MAX_BASH_OUTPUT_CHARS) +
        `\n\n... [${remainingLines} lines truncated] ...` +
        (saved ? `\n完整输出已保存: ${saved}（可用 read 工具读取）` : '');
    }
    return { type: 'bash' as const, command, output: body };
  };
  try {
    const { stdout, stderr } = await execAsync(command, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    let out = stdout;
    if (stderr) out += '\n[stderr] ' + stderr;
    return finish(cwdTag + '\n' + (out || '(无输出)'));
  } catch (e: unknown) {
    const err = e as { killed?: boolean; stdout?: string; stderr?: string; code?: number; message?: string };
    if (err.killed) return { type: 'bash' as const, command, output: cwdTag + '\n错误：命令执行超时（30秒）' };
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
  if (!needResize && !needCompress) return { data: raw, mediaType: mtOf(ext) };

  let pipeline = img;
  if (needResize) {
    const ratio = Math.min(IMAGE_MAX_WIDTH / width, IMAGE_MAX_HEIGHT / height);
    pipeline = img.resize(Math.round(width * ratio), Math.round(height * ratio), { fit: 'fill' });
  }
  const cands: Array<[Buffer, string]> = [];
  cands.push([await pipeline.clone().png({ compressionLevel: 9 }).toBuffer(), 'image/png']);
  cands.push([await pipeline.clone().flatten().jpeg({ quality: 80 }).toBuffer(), 'image/jpeg']);
  cands.sort((a, b) => a[0].length - b[0].length);
  for (const [d, mt] of cands) if (d.length <= IMAGE_TARGET_RAW_SIZE) return { data: d, mediaType: mt };

  for (const q of [80, 60, 40, 20]) {
    const d = await pipeline.clone().flatten().jpeg({ quality: q }).toBuffer();
    if (d.length <= IMAGE_TARGET_RAW_SIZE) return { data: d, mediaType: 'image/jpeg' };
  }
  const ratio = 1000 / (width || 1000);
  const d = await img.resize(1000, Math.round((height || 1000) * ratio)).flatten().jpeg({ quality: 20 }).toBuffer();
  return { data: d, mediaType: 'image/jpeg' };
}

// read：读取文本文件，支持 offset/limit 行范围分页（对齐 CC FileReadTool）。
// 大文件不截断——默认读前 400 行，未读完返回提示用 offset 续读。
// 图片已分离到 view 工具（职责分离：文本 read / 视觉 view，对齐 Codex view_image）。
async function readFile(p: string, offset = 1, limit?: number) {
  const ext = path.extname(p).toLowerCase();
  if (IMAGE_EXTENSIONS.includes(ext)) {
    return { type: 'error' as const, message: `"${p}" 是图片文件（${ext}），请使用 view 工具查看图片` };
  }
  try {
    const content = await fsReadFile(p, 'utf-8');
    const lines = content.split('\n');
    const total = lines.length;
    const pageSize = Math.max(1, Math.floor(limit ?? 400)); // limit ≤ 0 钳制为 1，防空页死循环
    const start = Math.max(0, offset - 1);
    if (start >= total) {
      return { type: 'text' as const, content: `[offset=${offset} 超出文件总行数 ${total}，请用较小的 offset]` };
    }
    const page = lines.slice(start, start + pageSize);
    let out = page.join('\n');
    if (start + pageSize < total) {
      const end = start + page.length;
      out += `\n\n[已读第 ${start + 1}-${end} 行，共 ${total} 行；继续请用 offset=${end + 1}]`;
    }
    return { type: 'text' as const, content: out };
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
    return { type: 'image' as const, path: p, media_type: mediaType, base64: b64, size };
  } catch (e) {
    return { type: 'error' as const, message: `错误：${(e as Error).message}` };
  }
}

async function writeFile(p: string, content: string) {
  try {
    await mkdir(path.dirname(p) || '.', { recursive: true });
    await fsWriteFile(p, content, 'utf-8');
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
  if (count === 0) return '错误：未找到要替换的文本';
  if (count > 1 && !replaceAll) return `错误：找到 ${count} 处匹配，请提供更多上下文或设置 replace_all=true`;
  const newContent = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
  await fsWriteFile(p, newContent, 'utf-8');
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
    function: (a) => runBash(a.command as string),
    concurrencySafe: false,
    schema: {
      name: 'bash',
      description: '在本地执行 shell 命令并返回输出。注意：工作目录为当前会话目录（见输出开头的 [cwd]；--resume 恢复会话时会切换到会话对应目录；每次调用都是全新 shell，cd 不会跨调用保留），请使用绝对路径或相对当前目录的路径',
      input_schema: { type: 'object', properties: { command: { type: 'string', description: '要执行的 shell 命令' } }, required: ['command'] },
    },
  },
  read: {
    function: (a) => readFile(a.path as string, a.offset as number | undefined, a.limit as number | undefined),
    concurrencySafe: true,
    schema: {
      name: 'read',
      description: '读取文本文件内容。支持行范围分页：offset=起始行（从 1 开始，默认 1）、limit=读取行数（默认 400）；未读完会提示用 offset 续读。图片文件请用 view 工具查看',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          offset: { type: 'number', description: '起始行号（从 1 开始，默认 1）' },
          limit: { type: 'number', description: '读取行数（默认 400；未读完会提示续读 offset）' },
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
      description: '查看图片文件（png/jpg/jpeg/gif/webp/bmp），压缩后以视觉输入返回。文本文件请用 read 工具读取',
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
      description: '对文件执行精确的文本替换。old_string 必须在文件中唯一（除非 replace_all=true）。',
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
    concurrencySafe: false,
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
