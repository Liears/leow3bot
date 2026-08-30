// E2E 主跑器：mock LLM 服务器 + script(1) 分配 PTY 跑真实 main.tsx 进程。
// 隔离三旋钮：LEOW3BOT_HOME（配置/会话落盘）、LEOW3BOT_API_BASE_URL（指向 mock）、
// 独立临时项目目录。每场景全新隔离环境，串行执行。
//
// 运行：npm run test:e2e（或 npm test 全量链的最后一步）

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import stripAnsi from 'strip-ansi';
import { StringDecoder } from 'node:string_decoder';
import { startMockServer, type MockServer } from './mock-server.js';

const MODEL_ID = 'glm-e2e-model';
// runner 与 mock handler 共享的场景状态（工具循环 marker 由 runner 注入）
const e2eState = { toolMarker: 'e2e-tool-marker' };
const REPO = path.resolve(import.meta.dirname, '..', '..');

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
  if (!cond) failures++;
}

interface AppSession {
  child: ChildProcess;
  output: string; // 累计 stdout+stderr（已去 ANSI）
  send: (s: string) => void;
  waitFor: (needle: string, timeoutMs?: number) => Promise<boolean>;
  waitExit: (timeoutMs?: number) => Promise<number | null>;
  dispose: () => void;
}

/** 起一个真实 app 进程（PTY via script），带全套隔离环境 */
function startApp(opts: {
  home: string;
  projectDir: string;
  apiUrl: string;
  extraEnv?: Record<string, string>;
}): AppSession {
  const tsxCli = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const inner = `stty rows 40 cols 120 2>/dev/null; node ${tsxCli} ${path.join(REPO, 'src', 'main.tsx')}`;
  // CI 类环境变量显式清空（is-in-ci 检测 CI !== 'false' 即判定 CI 环境）——
  // 见下方 env 注释；'false' 而非 delete，防 ...process.env 再带入
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: 'false',
    GITHUB_ACTIONS: 'false',
    CONTINUOUS_INTEGRATION: 'false',
    LEOW3BOT_HOME: opts.home,
    LEOW3BOT_API_BASE_URL: opts.apiUrl,
    FORCE_COLOR: '1',
    ...opts.extraEnv,
  };
  const child = spawn('script', ['-qec', inner, '/dev/null'], {
    cwd: opts.projectDir,
    // 注意：子进程不能处于 ink 认定的 CI 环境——CI 模式下动态区（提示符/状态栏/
    // spinner）只存 lastOutput 不写出（"CIs don't handle erasing ansi escapes
    // well"），E2E 会永远等不到交互界面。上面的 env 已把 CI 类变量置 'false'。
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // StringDecoder 缓冲跨 chunk 的不完整多字节序列：'❯'（3 字节）被 chunk 边界
  // 劈开时 toString 会产 U+FFFD，字符串匹配永远失配（表现：welcome 正常但提示符
  // 永远等不到）。stripAnsi 延迟到读取时做（escape 序列同样可能跨 chunk）。
  const decOut = new StringDecoder('utf-8');
  const decErr = new StringDecoder('utf-8');
  let raw = '';
  let textCache = '';
  child.stdout!.on('data', (d: Buffer) => { raw += decOut.write(d); textCache = ''; });
  child.stderr!.on('data', (d: Buffer) => { raw += decErr.write(d); textCache = ''; });
  const output = () => (textCache || (textCache = stripAnsi(raw)));

  const waitFor = async (needle: string, timeoutMs = 30_000): Promise<boolean> => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (output().includes(needle)) return true;
      await new Promise(r => setTimeout(r, 200));
    }
    console.log(`    [waitFor 超时] 期望「${needle}」，输出尾部：\n${output().slice(-2600).replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')}`);
    return false;
  };
  const waitExit = async (timeoutMs = 15_000): Promise<number | null> => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (child.exitCode !== null) return child.exitCode;
      await new Promise(r => setTimeout(r, 200));
    }
    return null;
  };
  return {
    child,
    get output() { return output(); },
    send: (s: string) => {
      // 文本先行，回车稍后单独送达（见上注）；多行/特殊输入由调用方自行分次 send
      const cr = s.endsWith('\r') ? '\r' : '';
      const text = cr ? s.slice(0, -1) : s;
      if (text) child.stdin!.write(text);
      setTimeout(() => { try { child.stdin!.write(cr); } catch { /* 进程已退出 */ } }, cr ? 120 : 0);
    },
    waitFor, waitExit,
    dispose: () => { if (child.exitCode === null) child.kill('SIGKILL'); },
  };
}

function freshEnv(tag: string): { home: string; projectDir: string } {
  const base = mkdtempSync(path.join(tmpdir(), `leow3bot-e2e-${tag}-`));
  const home = path.join(base, 'home');
  const projectDir = path.join(base, 'project');
  mkdirSync(path.join(home, '.leow3bot'), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  // 显式 model → 跳过 autoDetectModel；apiKey → 跳过 onboarding
  writeFileSync(path.join(home, '.leow3bot', 'config.json'), JSON.stringify({
    apiKey: 'e2e-test-key', model: MODEL_ID, contextWindow: 192000,
  }, null, 2));
  return { home, projectDir };
}

// ============================================================
// 场景
// ============================================================

async function scenarioBoot(apiUrl: string): Promise<void> {
  console.log('\n场景 1：启动渲染（welcome/logo/状态栏/输入提示符）');
  const { home, projectDir } = freshEnv('boot');
  const app = startApp({ home, projectDir, apiUrl });
  try {
    assert(await app.waitFor('Leow3Bot'), 'welcome 含名称 Leow3Bot');
    assert(await app.waitFor(MODEL_ID), `状态栏含模型 ${MODEL_ID}`);
    assert(await app.waitFor('❯'), '输入提示符出现');
    assert(!app.output.includes('onboarding'), '已配置 key 不进 onboarding');
  } finally {
    app.dispose();
    rmSync(path.dirname(home), { recursive: true, force: true });
  }
}

async function scenarioHelpCommand(apiUrl: string): Promise<void> {
  console.log('\n场景 2：斜杠命令 /help');
  const { home, projectDir } = freshEnv('help');
  const app = startApp({ home, projectDir, apiUrl });
  try {
    await app.waitFor('❯');
    app.send('/help\r');
    assert(await app.waitFor('/clear'), '/help 输出命令列表');
    assert(await app.waitFor('/model'), '列表含 /model');
  } finally {
    app.dispose();
    rmSync(path.dirname(home), { recursive: true, force: true });
  }
}

async function scenarioPlainChat(apiUrl: string): Promise<void> {
  console.log('\n场景 3：纯文本对话（mock 流式回复全链路）');
  const { home, projectDir } = freshEnv('chat');
  const app = startApp({ home, projectDir, apiUrl });
  try {
    await app.waitFor('❯');
    app.send('你好\r');
    assert(await app.waitFor('你好，这是 E2E 测试回复'), '流式回复渲染到 scrollback');
    // thinking 流也进了 scrollback（/verbose 默认展开）
    assert(app.output.includes('用户打招呼'), 'thinking 流渲染');
  } finally {
    app.dispose();
    rmSync(path.dirname(home), { recursive: true, force: true });
  }
}

async function scenarioToolLoop(apiUrl: string, server: MockServer): Promise<void> {
  console.log('\n场景 4：工具全循环（LLM→bash→tool_result 回传→最终回复）');
  const requestsBefore = server.requests.length;
  const { home, projectDir } = freshEnv('tool');
  e2eState.toolMarker = `e2e-tool-marker-${Date.now()}`;
  const app = startApp({ home, projectDir, apiUrl });
  try {
    await app.waitFor('❯');
    app.send('执行那个命令\r');
    // 第 1 轮：模型发 tool_use bash；app 真实执行 echo；第 2 轮带回 tool_result
    assert(await app.waitFor('工具循环完成，标记已确认'), '最终回复渲染');
    assert(app.output.includes('[cwd:'), 'bash 输出带 [cwd] 前缀');

    // 服务端契约断言：第 2 个流请求的 last message 必须是 tool_result 且含真实命令输出
    const streamReqs = server.requests.slice(requestsBefore)
      .filter(r => r.path.endsWith('/v1/messages') && r.body.stream === true);
    assert(streamReqs.length >= 2, `两次 LLM 请求（实际 ${streamReqs.length}）`);
    const second = streamReqs[1];
    const msgs = (second?.body.messages ?? []) as Array<{ role: string; content: unknown }>;
    const last = msgs[msgs.length - 1];
    const trBlocks = Array.isArray(last?.content)
      ? (last!.content as Array<{ type: string; tool_use_id?: string; content?: unknown }>).filter(b => b.type === 'tool_result')
      : [];
    assert(last?.role === 'user' && trBlocks.length === 1, 'tool_result 紧随 tool_use 回传（Anthropic 契约）');
    assert(String(trBlocks[0]?.content ?? '').includes(e2eState.toolMarker), 'tool_result 含真实命令输出（工具真的执行了）');
    // 首请求带完整工具表与 system
    assert(Array.isArray(streamReqs[0]?.body.tools) && (streamReqs[0].body.tools as unknown[]).length > 0, '请求带工具 schema 表');
    assert(typeof streamReqs[0]?.body.system === 'string' && (streamReqs[0].body.system as string).length > 0, '请求带 system prompt');
  } finally {
    app.dispose();
    rmSync(path.dirname(home), { recursive: true, force: true });
  }
}

async function scenarioAutosave(apiUrl: string): Promise<void> {
  console.log('\n场景 5：会话 autosave + title 生成');
  const { home, projectDir } = freshEnv('save');
  const app = startApp({ home, projectDir, apiUrl });
  try {
    await app.waitFor('❯');
    app.send('记住这句话\r');
    assert(await app.waitFor('好的，已记住'), '回复完成');
    // title 是后台异步生成 + 重写 autosave——轮询等它落盘（固定 sleep 在慢盘上会 flaky）
    const sessDir = path.join(home, '.leow3bot', 'sessions');
    let files: string[] = [];
    let data: { message_count?: number; name?: string; projectRoot?: string } | null = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 15_000) {
      files = existsSync(sessDir) ? readdirSync(sessDir).filter(f => f.startsWith('current_')) : [];
      if (files.length) {
        try { data = JSON.parse(readFileSync(path.join(sessDir, files[0]), 'utf-8')); } catch { /* 写入中 */ }
        if (data?.name === 'E2E 会话主题') break; // 主题已写入 = title+autosave 双完成
      }
      await new Promise(r => setTimeout(r, 300));
    }
    assert(files.length === 1, `autosave 落盘（${files.length} 个 current 文件）`);
    if (data) {
      assert((data.message_count ?? 0) >= 2, `消息数 ≥2（实际 ${data.message_count}）`);
      assert(data.name === 'E2E 会话主题', `后台生成的主题写入（实际 "${data.name}"）`);
      assert(data.projectRoot === projectDir, 'projectRoot 记录正确');
    }
  } finally {
    app.dispose();
    rmSync(path.dirname(home), { recursive: true, force: true });
  }
}

async function scenarioExit(apiUrl: string): Promise<void> {
  console.log('\n场景 6：/q 干净退出');
  const { home, projectDir } = freshEnv('exit');
  const app = startApp({ home, projectDir, apiUrl });
  try {
    await app.waitFor('❯');
    app.send('/q\r');
    const code = await app.waitExit();
    assert(code === 0, `进程退出码 0（实际 ${code}）`);
  } finally {
    app.dispose();
    rmSync(path.dirname(home), { recursive: true, force: true });
  }
}

// ============================================================
// main
// ============================================================

const server = await startMockServer({
  model: MODEL_ID,
  onStreamRequest: (body, n) => {
    const msgs = (body.messages ?? []) as Array<{ role: string; content: unknown }>;
    const last = msgs[msgs.length - 1];
    const hasToolResult = Array.isArray(last?.content) &&
      (last!.content as Array<{ type: string }>).some(b => b.type === 'tool_result');
    const userText = typeof last?.content === 'string' ? last.content : '';
    if (hasToolResult) {
      // 工具结果已回传 → 最终回复
      return { script: { text: '工具循环完成，标记已确认' }, stopReason: 'end_turn' };
    }
    if (userText.includes('记住这句话')) {
      return { script: { thinking: '用户让我记住', text: '好的，已记住' }, stopReason: 'end_turn' };
    }
    if (userText.includes('执行那个命令')) {
      return {
        script: {
          thinking: '我需要调用 bash 工具',
          toolCall: { id: 'toolu_e2e_bash', name: 'bash', input: { command: `echo ${e2eState.toolMarker}` } },
        },
        stopReason: 'tool_use',
      };
    }
    if (n === 1 || userText.includes('你好')) {
      return { script: { thinking: '用户打招呼', text: '你好，这是 E2E 测试回复' }, stopReason: 'end_turn' };
    }
    return { script: { text: '收到' }, stopReason: 'end_turn' };
  },
  onJsonRequest: () => 'E2E 会话主题',
});

const apiUrl = `http://127.0.0.1:${server.port}/api/anthropic`;
console.log(`mock LLM 服务器: ${apiUrl}`);

try {
  await scenarioBoot(apiUrl);
  await scenarioHelpCommand(apiUrl);
  await scenarioPlainChat(apiUrl);
  await scenarioToolLoop(apiUrl, server);
  await scenarioAutosave(apiUrl);
  await scenarioExit(apiUrl);
} finally {
  await server.close();
}

console.log(failures === 0
  ? '\n=== E2E 全部通过 ==='
  : `\n=== E2E 失败 ${failures} 项 ===`);
process.exit(failures === 0 ? 0 : 1);
