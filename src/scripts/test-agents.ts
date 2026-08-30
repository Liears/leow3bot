// SubAgent 单测：loader 解析 / 工具集过滤与只读闸 / 重复派发检测 / 结果包装截断 /
// runAgentLoop 假流集成（streamFn 注入，脱离真实 LLM 驱动完整子代理生命周期）。

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { loadAgents, AGENTS_REGISTRY } = await import('../subagents/loader.js');
const { buildToolset, checkDuplicateDispatch, recordDispatch, packageResult, resolveSubagentModel, SILENT_SINK, makeSubagentSink, buildSubagentSystem } = await import('../subagents/runner.js');
const { getState: getStoreState, subagentStart: ssStart, subagentEnd: ssEnd } = await import('../store.js');
const { runAgentLoop } = await import('../agent.js');
type AgentLoopSink = import('../agent.js').AgentLoopSink;
const { TOOLS_REGISTRY } = await import('../tools.js');
type ToolDef = import('../tools.js').ToolDef;
const { MODEL, getSubagentModel } = await import('../config.js');
type MessageParam = import('../types.js').MessageParam;
type StreamEvent = import('../types.js').StreamEvent;
type ToolResultBlock = import('../types.js').ToolResultBlock;

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
  if (!cond) failures++;
}

// ============================================================
// 1. Loader
// ============================================================
console.log('loader 解析:');
const dirA = mkdtempSync(path.join(tmpdir(), 'leow3bot-agents-a-'));
const dirB = mkdtempSync(path.join(tmpdir(), 'leow3bot-agents-b-'));
try {
  writeFileSync(path.join(dirA, 'alpha.md'), '---\nname: alpha\ndescription: 测试代理甲\ntools: [read, view]\nmaxTurns: 30\n---\n正文A');
  writeFileSync(path.join(dirA, 'no-desc.md'), '---\nname: nodescription\n---\n正文'); // 缺 description → 跳过
  writeFileSync(path.join(dirA, 'beta.md'), '---\ndescription: 无 name 字段回退文件名\n---\n正文B');
  writeFileSync(path.join(dirB, 'alpha.md'), '---\nname: alpha\ndescription: 覆盖版描述\n---\n正文A2'); // 后扫目录覆盖
  writeFileSync(path.join(dirB, 'explore.md'), '---\nname: explore\ndescription: 用户自定义 explore 覆盖内置\n---\n自定义正文');

  loadAgents([]); // 仅内置
  assert(AGENTS_REGISTRY.has('explore') && AGENTS_REGISTRY.get('explore')!.builtin === true, '内置 explore 注册');

  loadAgents([dirA]);
  const alphaA = AGENTS_REGISTRY.get('alpha')!;
  assert(alphaA.maxTurns === 30 && alphaA.tools?.join(',') === 'read,view', 'frontmatter tools/maxTurns 解析');

  loadAgents([dirA, dirB]);
  const alpha = AGENTS_REGISTRY.get('alpha')!;
  assert(alpha.description === '覆盖版描述' && alpha.content === '正文A2', '同名后扫目录覆盖先扫');
  assert(!AGENTS_REGISTRY.has('nodescription'), '缺 description 的文件跳过');
  assert(AGENTS_REGISTRY.get('beta')?.name === 'beta', 'name 缺失回退文件名');
  assert(AGENTS_REGISTRY.get('explore')?.description === '用户自定义 explore 覆盖内置', '用户定义覆盖内置 explore');
} finally {
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
}
loadAgents([]); // 恢复仅内置，供后续测试

// ============================================================
// 2. buildToolset：过滤 / 强制剔除 / 未知工具 / 只读判定
// ============================================================
console.log('工具集组装:');
const explore = AGENTS_REGISTRY.get('explore')!;
const ts = buildToolset(explore);
assert(!ts.error, 'explore 工具集无错误');
const keys = Object.keys(ts.registry).sort().join(',');
assert(keys === 'bash,read,skill,view,web_fetch,web_search', `explore 白名单过滤（实际: ${keys}）`);

const forceRemove = buildToolset({ ...explore, tools: ['read', 'ask', 'subagent'] });
assert(!Object.keys(forceRemove.registry).includes('ask') && !Object.keys(forceRemove.registry).includes('subagent'), 'ask/subagent 强制剔除（白名单写了也无效）');

const unknown = buildToolset({ ...explore, tools: ['read', 'nosuchtool'] });
assert(!!unknown.error && unknown.error.includes('nosuchtool'), '未知工具名报错（不静默丢弃）');

const fullSet = buildToolset({ ...explore, tools: undefined });
assert(Object.keys(fullSet.registry).length === Object.keys(TOOLS_REGISTRY).length - 2, '缺省白名单 = 全量注册表（扣 subagent/ask 强制剔除）');

// ============================================================
// 3. 只读闸（方案 B）
// ============================================================
console.log('只读 bash 闸:');
const exploreBash = ts.registry['bash'];
const blockedCases = [
  'echo x > file.txt',
  'echo x >> log.txt',
  'touch newfile',
  'rm -rf dist',
  'cp a b',
  'mkdir d',
  'mv a b',
  "sed -i 's/a/b/' f",
  'find . -name x -delete',
  'find . -exec rm {} \\;',
  'tee out.txt',
];
for (const cmd of blockedCases) {
  const r = await exploreBash.function({ command: cmd }) as { type?: string; message?: string };
  assert(r.type === 'error' && (r.message ?? '').includes('只读代理禁止写操作'), `拦截 ← ${cmd}`);
}
const allowedCases = ['grep -rn leow3bot src', 'ls -la', 'find . -name "*.ts" 2>/dev/null', 'echo guard-ok-12345'];
for (const cmd of allowedCases) {
  const r = await exploreBash.function({ command: cmd }) as { type?: string; output?: string };
  assert(r.type === 'bash', `放行 ← ${cmd}`);
}
// 非只读代理（白名单含 write）的 bash 不包装
const writable = buildToolset({ ...explore, name: 'writer', tools: ['read', 'write', 'bash'] });
const wR = await writable.registry['bash'].function({ command: 'echo guard-ok-12345' }) as { output?: string };
assert((wR.output ?? '').includes('guard-ok-12345'), '含 write 的代理 bash 不受只读闸限制');

// ============================================================
// 4. 模型解析 + 重复派发
// ============================================================
console.log('模型解析与重复派发:');
assert(resolveSubagentModel({ ...explore, model: 'custom-model' }) === 'custom-model', 'agent 定义 model 最优先');
assert(resolveSubagentModel(explore) === (getSubagentModel() ?? MODEL), '回退顺序：/subagent 配置 > 继承主模型');

assert(checkDuplicateDispatch('task-A 首次派发') === null, '首次派发放行（查不记）');
assert(checkDuplicateDispatch('task-A 首次派发') === null, '只查不记：未 record 的文本反复查都不警告');
recordDispatch('task-A 首次派发');
assert(checkDuplicateDispatch('task-A 首次派发') !== null, '记录后同文本警告');
assert(checkDuplicateDispatch('task-B 不同任务') === null, '不同文本不受影响');

// ============================================================
// 5. packageResult：截断 / 空输出 / 错误 / 状态内带 / 结构契约
// ============================================================
console.log('结果包装:');
const longText = '## 概览\n' + 'x'.repeat(5000);
const pr = packageResult(explore, { status: 'done', finalText: longText, rounds: 3, toolCalls: 2, usage: null, error: null }, undefined, 'm1') as Record<string, unknown>;
assert((pr.report as string).length < 5100 && (pr.report as string).includes('已保存至'), '超长报告截断 + 落盘提示');
assert((pr.report as string).startsWith('[子代理 explore · 完成（3 轮/2 次工具）]'), '报告正文首行状态内带');
assert((pr.output as string).startsWith('完成（3 轮/2 次工具）'), '⎿ 摘要格式');
const empty = packageResult(explore, { status: 'done', finalText: '  ', rounds: 3, toolCalls: 2, usage: null, error: null }, undefined, 'm1') as { type?: string };
assert(empty.type === 'error', 'done 但零输出 → 如实报错');
const errRes = packageResult(explore, { status: 'error', finalText: '部分输出', rounds: 1, toolCalls: 0, usage: null, error: 'HTTP 500' }, undefined, 'm1') as { type?: string; message?: string };
assert(errRes.type === 'error' && (errRes.message ?? '').includes('HTTP 500'), 'error 状态 → 错误结果');
// 结构契约：done 但输出无 reportMarker（进度旁白）→ 未完成错误
const narration = packageResult(explore, { status: 'done', finalText: '✓ 第 7 页已读：……继续第 8 页：', rounds: 8, toolCalls: 12, usage: null, error: null }, undefined, 'm1') as { type?: string; message?: string };
assert(narration.type === 'error' && (narration.message ?? '').includes('提前停止'), '进度旁白伪装报告 → 契约拦截为未完成');
// 无 reportMarker 的定义不做契约校验（用户自定义格式自由）
const noMarkerDef = { ...explore, name: 'free', reportMarker: undefined };
const free = packageResult(noMarkerDef, { status: 'done', finalText: '纯文本结论', rounds: 2, toolCalls: 1, usage: null, error: null }, undefined, 'm1') as { type?: string; report?: string };
assert(free.type === 'task' && (free.report as string).includes('纯文本结论'), '无契约定义不校验格式');
// interrupted：状态内带标注未完成
const intRes = packageResult(explore, { status: 'interrupted', finalText: '## 概览\n部分内容', rounds: 5, toolCalls: 3, usage: null, error: null }, undefined, 'm1') as { report?: string };
assert((intRes.report as string).includes('被中断'), 'interrupted 报告标注不完整');

// ============================================================
// 6. runAgentLoop 假流集成：完整子代理生命周期
// ============================================================
console.log('假流集成（streamFn 注入）:');
const fakeTool: ToolDef = {
  function: () => ({ type: 'text' as const, content: '工具结果 ok' }),
  concurrencySafe: true,
  schema: { name: 'probe', description: '测试探针工具', input_schema: { type: 'object', properties: {}, required: [] } },
};
const rounds: StreamEvent[][] = [
  [ // 第 1 轮：思考 → 工具调用
    { type: 'thinking', text: '先想想' },
    {
      type: 'tool_call',
      assistant_msg: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'probe', input: {} }] },
      tool_calls: [{ id: 't1', name: 'probe', input: {} }],
      usage: { input_tokens: 10, output_tokens: 5 }, timing: { ttft: 1, decode_time: 1, total: 10 },
    },
  ],
  [ // 第 2 轮：正文 → 完成
    { type: 'text', text: '报告：' },
    { type: 'text', text: '探查完成' },
    {
      type: 'done',
      assistant_msg: { role: 'assistant', content: [{ type: 'text', text: '报告：探查完成' }] },
      usage: { input_tokens: 20, output_tokens: 8 }, timing: { ttft: 1, decode_time: 1, total: 10 },
    },
  ],
];
let ri = 0;
const streamFn: typeof import('../llm.js').callLLMStream = async function* () {
  for (const ev of rounds[ri++] ?? []) yield ev;
};
const loopMessages: MessageParam[] = [{ role: 'user', content: '测试任务' }];
let sinkEvents = 0;
const countingSink: AgentLoopSink = {
  ...SILENT_SINK,
  event: () => { sinkEvents++; },
};
const loopResult = await runAgentLoop({ current: null }, {
  messages: loopMessages, system: '测试 system', tools: [fakeTool.schema], registry: { probe: fakeTool },
  maxRounds: 5, sink: countingSink, autosave: false, streamFn,
});
assert(loopResult.status === 'done', '状态 done');
assert(loopResult.finalText === '报告：探查完成', 'finalText = 末条 assistant 文本');
assert(loopResult.rounds === 2 && loopResult.toolCalls === 1, '轮数/工具调用计数');
assert(loopMessages.length === 4, '消息契约长度（user→assistant→tool_result→assistant）');
const trMsg = loopMessages[2];
const trBlock = (Array.isArray(trMsg.content) ? trMsg.content[0] : null) as ToolResultBlock | null;
assert(!!trBlock && trBlock.type === 'tool_result' && trBlock.tool_use_id === 't1', 'tool_result 紧随 tool_use（Anthropic 契约）');
assert(sinkEvents === 2, 'sink 只收到 tool_start + tool_result 两个事件（静默隔离）');
assert((loopResult.usage as { output_tokens?: number }).output_tokens === 13, 'usage 累加（5+8）');

// ============================================================
// 7. 状态面板 sink（动态区可见性）
// ============================================================
console.log('状态面板 sink:');
const panelKey = 'test-panel-1';
ssStart({ key: panelKey, name: 'explore', desc: '测试面板', rounds: 0, toolCalls: 0, activity: '启动中…', startedAt: Date.now() });
const panelSink = makeSubagentSink(panelKey);
panelSink.event({ kind: 'tool_start', call: { id: 'x', name: 'bash', input: { command: 'grep -rn auth src/' } } });
panelSink.event({ kind: 'tool_result', call: { id: 'x', name: 'bash', input: {} }, result: {} });
panelSink.usage({ input_tokens: 1 }, { ttft: 1, decode_time: 1, total: 1 });
const entry = getStoreState().subagents.find(x => x.key === panelKey)!;
assert(!!entry && entry.activity === 'bash: grep -rn auth src/' && entry.toolCalls === 1, 'tool_start 更新 activity 与计数（tool_result 不计）');
assert(entry.rounds === 1, 'usage 触发轮数计');
ssEnd(panelKey);
assert(!getStoreState().subagents.some(x => x.key === panelKey), '结束移除面板行');

// ============================================================
// 8. bash 进程组回收（leo 退出不留守孤儿）
// ============================================================
console.log('bash 进程组回收:');
const { killActiveBash } = await import('../tools.js');
const bashTool = TOOLS_REGISTRY['bash']!;
// 用独特的 sleep 时长防与环境中其他 sleep 撞车（ps 按此过滤）
const p1 = bashTool.function({ command: 'sh -c "sleep 297"', timeout: 300 }) as Promise<{ type?: string; output?: string }>;
await new Promise(r => setTimeout(r, 400)); // 等 spawn 注册进 ACTIVE_BASH_PGIDS
killActiveBash(); // 模拟 main.tsx 的 exit 钩子
const r1 = await p1;
assert(r1.type === 'bash', '组杀后命令正常返回结果');
await new Promise(r => setTimeout(r, 400)); // 等僵尸回收
const { execSync } = await import('node:child_process');
let alive = '';
try { alive = execSync('ps -eo pid,cmd | grep "sleep 297" | grep -v grep || true').toString(); } catch { /* ps 空 */ }
assert(!alive.includes('sleep 297'), 'exit 钩子组杀后孙进程（sleep）已死，无孤儿');

// ============================================================
// 9. 工具打点 + 子代理语境语义（interactive=false）
// ============================================================
console.log('工具打点与子代理语境:');
const { executeTool } = await import('../executor.js');
const slowTool: ToolDef = {
  function: () => new Promise(r => setTimeout(() => r({ type: 'text', content: '慢工具完成' }), 1200)),
  concurrencySafe: true,
  schema: { name: 'slowprobe', description: '慢探针', input_schema: { type: 'object', properties: {}, required: [] } },
};
const pSlow = executeTool('slowprobe', {}, { slowprobe: slowTool });
await new Promise(r => setTimeout(r, 300));
const row = getStoreState().runningTools.find(x => x.name === 'slowprobe');
assert(!!row && row.summary === '', '执行中工具登记打点行（无代表性入参则摘要为空）');
const rSlow = await pSlow as { content?: string };
assert(rSlow.content === '慢工具完成', '工具正常完成');
assert(!getStoreState().runningTools.some(x => x.name === 'slowprobe'), '完成移除打点行');
// interactive=false（子代理语境）：deny 黑名单照常 + 不登记打点
const rDeny = await executeTool('bash', { command: 'rm -rf /' }, TOOLS_REGISTRY, false) as { type?: string; message?: string };
assert(rDeny.type === 'error' && (rDeny.message ?? '').includes('权限管控'), 'deny 黑名单在子代理语境照常生效');
const before = getStoreState().runningTools.length;
const rQuiet = await executeTool('bash', { command: 'echo x' }, TOOLS_REGISTRY, false) as { type?: string; output?: string };
assert(rQuiet.type === 'bash', '子代理语境工具正常执行');
assert(getStoreState().runningTools.length === before, 'interactive=false 不登记通用打点行（专属行已覆盖）');

// ============================================================
// 10. 并发信号量（超额排队而非拒绝）
// ============================================================
console.log('并发信号量:');
const { withSlot } = await import('../subagents/runner.js');
const { MAX_CONCURRENT_SUBAGENTS } = await import('../config.js');
let cur = 0;
let peak = 0;
const task = async () => {
  cur++;
  peak = Math.max(peak, cur);
  await new Promise(r => setTimeout(r, 80));
  cur--;
};
await Promise.all(Array.from({ length: 5 }, () => withSlot(task)));
assert(peak <= MAX_CONCURRENT_SUBAGENTS, `5 路并发被限流（峰值 ${peak} ≤ ${MAX_CONCURRENT_SUBAGENTS}）`);
assert(peak >= 2, `确实并行执行（峰值 ${peak} ≥ 2，非串行）`);

// ============================================================
// 11. TDD 补测：未覆盖行为（失败即 bug 按 RED-GREEN 修；全过则固化回归保护）
// ============================================================
console.log('TDD 补测:');

// 11.1 注册表入口活体：动态 import 链（tools → runner → agent → tools 潜在环）+ 护栏
const subEntry = TOOLS_REGISTRY['subagent']!;
const subTooShort = await subEntry.function({ prompt: '太短' }) as { type?: string; message?: string };
assert(subTooShort.type === 'error' && (subTooShort.message ?? '').includes('过短'), '入口可调用：短 prompt 拒发（import 环无运行时崩溃）');
const subUnknown = await subEntry.function({ prompt: '查询这个项目里所有处理鉴权的代码位置', agent_type: 'nosuch' }) as { type?: string; message?: string };
assert(subUnknown.type === 'error' && (subUnknown.message ?? '').includes('未知子代理类型'), '未知类型报错且列出可用类型');

// 11.2 轮间中止：externalSignal 已中止 → 不发起任何 LLM 调用直接 interrupted
{
  let llmCalls = 0;
  const sf: typeof import('../llm.js').callLLMStream = async function* () { llmCalls++; };
  const aborted = new AbortController();
  aborted.abort();
  const res = await runAgentLoop({ current: null }, {
    messages: [{ role: 'user', content: '任务' }], system: 's', tools: [], registry: {},
    maxRounds: 5, sink: SILENT_SINK, autosave: false, externalSignal: aborted.signal, streamFn: sf,
  });
  assert(res.status === 'interrupted' && llmCalls === 0, '外部已中止 → 零 LLM 调用返回 interrupted');
}

// 11.3 子代理 system 组装：正文在前 + 环境块 + web 指引
{
  const sys = buildSubagentSystem(explore, ts.registry);
  assert(sys.startsWith(explore.content.slice(0, 30)), 'system = agent 正文在前');
  assert(sys.includes('## 环境') && sys.includes(process.cwd()), '环境块含工作目录');
  assert(sys.includes('web_search'), 'web 工具指引随工具集注入');
}

// 11.4 frontmatter reportMarker 解析
{
  const d = mkdtempSync(path.join(tmpdir(), 'leow3bot-agents-rm-'));
  try {
    writeFileSync(path.join(d, 'contract.md'), '---\nname: contract\ndescription: 契约测试\nreportMarker: "## 报告"\n---\n正文');
    loadAgents([d]);
    assert(AGENTS_REGISTRY.get('contract')?.reportMarker === '## 报告', 'frontmatter reportMarker 解析');
  } finally {
    loadAgents([]);
    rmSync(d, { recursive: true, force: true });
  }
}

// 11.5 自主搜索纠偏：连续 4 轮（每轮 ≥2 次搜索类调用）→ 第 4 轮结果尾注入提示，且只注一次
{
  const readTool: ToolDef = {
    function: () => ({ type: 'text' as const, content: '读到了' }),
    concurrencySafe: true,
    schema: { name: 'read', description: '读', input_schema: { type: 'object', properties: {}, required: [] } },
  };
  const dummySub: ToolDef = {
    function: () => 'x',
    concurrencySafe: false,
    schema: { name: 'subagent', description: '占位', input_schema: { type: 'object', properties: {}, required: [] } },
  };
  const reg: Record<string, ToolDef> = { read: readTool, subagent: dummySub };
  const makeRounds = (): StreamEvent[][] => {
    const rs: StreamEvent[][] = [];
    for (let i = 0; i < 4; i++) {
      const calls = [
        { id: `t${i}a`, name: 'read', input: {} },
        { id: `t${i}b`, name: 'read', input: {} },
      ];
      rs.push([{
        type: 'tool_call',
        assistant_msg: { role: 'assistant', content: calls.map(c => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: c.input })) },
        tool_calls: calls, usage: { input_tokens: 1 }, timing: { ttft: 1, decode_time: 1, total: 1 },
      }]);
    }
    rs.push([{
      type: 'done',
      assistant_msg: { role: 'assistant', content: [{ type: 'text' as const, text: '## 概览\n最终' }] },
      usage: null, timing: { ttft: 1, decode_time: 1, total: 1 },
    }]);
    return rs;
  };
  const countHints = (msgs: MessageParam[]): number =>
    msgs.reduce((n, m) => n + (Array.isArray(m.content)
      ? m.content.filter(b => typeof (b as { content?: unknown }).content === 'string' && String((b as { content: string }).content).includes('[提示]')).length
      : 0), 0);

  // 主对话语境（interactive 缺省 true）
  let ri = 0;
  const rs = makeRounds();
  const sf: typeof import('../llm.js').callLLMStream = async function* () { for (const ev of rs[ri++] ?? []) yield ev; };
  const msgs: MessageParam[] = [{ role: 'user', content: '搜' }];
  const res = await runAgentLoop({ current: null }, {
    messages: msgs, system: 's', tools: [readTool.schema], registry: reg,
    maxRounds: 10, sink: SILENT_SINK, autosave: false, streamFn: sf,
  });
  assert(res.status === 'done', '纠偏场景循环正常完成');
  assert(countHints(msgs) === 1, `连续 4 轮自主搜索 → 恰好注入 1 次提示（实际 ${countHints(msgs)}）`);
  const r4 = msgs[8]; // 第 4 轮 tool_result 所在 user 消息
  const r4blocks = Array.isArray(r4.content) ? r4.content : [];
  const lastC = String((r4blocks[r4blocks.length - 1] as { content?: unknown } | undefined)?.content ?? '');
  assert(lastC.includes('[提示]') && lastC.includes('连续 4 轮'), '提示注入在第 4 轮最后一个结果尾部');

  // 子代理语境（interactive=false）不注入
  let ri2 = 0;
  const rs2 = makeRounds();
  const sf2: typeof import('../llm.js').callLLMStream = async function* () { for (const ev of rs2[ri2++] ?? []) yield ev; };
  const msgs2: MessageParam[] = [{ role: 'user', content: '搜' }];
  await runAgentLoop({ current: null }, {
    messages: msgs2, system: 's', tools: [readTool.schema], registry: reg,
    maxRounds: 10, sink: SILENT_SINK, autosave: false, interactive: false, streamFn: sf2,
  });
  assert(countHints(msgs2) === 0, '子代理语境（interactive=false）不注入纠偏提示');
}

// 11.7 图片类 400 毒化恢复（P2，实测事故：坏图进入历史后每轮 400，子代理整死）
// 期望：图片 payload 错误按可重试处理 → 重试后恢复，而非 status=error 终止
{
  let llmCalls = 0;
  const sf: typeof import('../llm.js').callLLMStream = async function* () {
    llmCalls++;
    if (llmCalls === 1) {
      throw new Error('HTTP 400: 400 {"type":"error","error":{"type":"invalid_request_error","code":"1210","message":"[1210][图片输入格式/解析错误][20260830...]"}');
    }
    yield {
      type: 'done',
      assistant_msg: { role: 'assistant', content: [{ type: 'text', text: '## 概览\n恢复后的报告' }] },
      usage: null, timing: { ttft: 1, decode_time: 1, total: 1 },
    } as StreamEvent;
  };
  const msgs: MessageParam[] = [{ role: 'user', content: '看图' }];
  const res = await runAgentLoop({ current: null }, {
    messages: msgs, system: 's', tools: [], registry: {},
    maxRounds: 5, sink: SILENT_SINK, autosave: false, streamFn: sf,
  });
  assert(res.status === 'done' && llmCalls === 2, `图片类 400 → 重试恢复（实际 status=${res.status}, LLM 调用 ${llmCalls} 次）`);
}

// 11.8 重复派发误伤（F1）：从未真正开始的任务（工具集报错在先）不应占重复检测的坑
{
  const { runSubagent } = await import('../subagents/runner.js');
  const broken = { ...explore, name: 'broken', tools: ['read', 'nosuchtool'] };
  AGENTS_REGISTRY.set('broken', broken);
  try {
    const P = '这是一条足够长的测试任务描述，用于验证未启动的任务不记录重复派发';
    const r1 = await runSubagent({ prompt: P, agent_type: 'broken' }) as { type?: string; message?: string };
    assert(r1.type === 'error' && (r1.message ?? '').includes('nosuchtool'), '前提：工具集报错，任务从未启动');
    const r2 = await runSubagent({ prompt: P, agent_type: 'broken' }) as { type?: string; message?: string };
    assert(!(r2.message ?? '').includes('疑似重复派发'), '未启动的任务重发不误伤（当前实现：护栏期即记录，误伤）');
  } finally {
    AGENTS_REGISTRY.delete('broken');
  }
}

console.log(failures === 0 ? '\n=== SubAgent 测试全部通过 ===' : `\n=== 失败 ${failures} 项 ===`);
process.exit(failures === 0 ? 0 : 1);
