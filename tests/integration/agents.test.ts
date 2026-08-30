// SubAgent 测试（迁移自 src/scripts/test-agents.ts，断言语义不变）：
// loader 解析 / 工具集过滤与只读闸 / 重复派发检测 / 结果包装截断 /
// runAgentLoop 假流集成（streamFn 注入，脱离真实 LLM 驱动完整子代理生命周期）。
// 置于 integration 层：跑真实 bash、ps、sharp（tools 注册表）。
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadAgents, AGENTS_REGISTRY } from '../../src/subagents/loader.js';
import {
  buildToolset, checkDuplicateDispatch, recordDispatch, packageResult, resolveSubagentModel,
  SILENT_SINK, makeSubagentSink, buildSubagentSystem, withSlot, runSubagent,
} from '../../src/subagents/runner.js';
import { getState as getStoreState, subagentStart as ssStart, subagentEnd as ssEnd } from '../../src/store.js';
import { runAgentLoop } from '../../src/agent.js';
import type { AgentLoopSink } from '../../src/agent.js';
import { TOOLS_REGISTRY, killActiveBash } from '../../src/tools.js';
import type { ToolDef } from '../../src/tools.js';
import { executeTool } from '../../src/executor.js';
import { MODEL, getSubagentModel, MAX_CONCURRENT_SUBAGENTS } from '../../src/config.js';
import type { MessageParam, StreamEvent, ToolResultBlock } from '../../src/types.js';

// describe 体在收集期执行（先于任何测试跑）——先装内置定义，收集期捕获的
// explore 引用即内置版（与原脚本时序语义一致：loader 测试后恢复仅内置）。
loadAgents([]);

// ============================================================
// 1. Loader（顺序依赖：后扫目录覆盖、恢复内置）
// ============================================================
describe('loader 解析', () => {
  const dirA = mkdtempSync(path.join(tmpdir(), 'leow3bot-agents-a-'));
  const dirB = mkdtempSync(path.join(tmpdir(), 'leow3bot-agents-b-'));

  it('内置 explore 注册', () => {
    loadAgents([]); // 仅内置
    expect(AGENTS_REGISTRY.has('explore')).toBe(true);
    expect(AGENTS_REGISTRY.get('explore')!.builtin).toBe(true);
  });

  it('frontmatter tools/maxTurns 解析', () => {
    writeFileSync(path.join(dirA, 'alpha.md'), '---\nname: alpha\ndescription: 测试代理甲\ntools: [read, view]\nmaxTurns: 30\n---\n正文A');
    writeFileSync(path.join(dirA, 'no-desc.md'), '---\nname: nodescription\n---\n正文'); // 缺 description → 跳过
    writeFileSync(path.join(dirA, 'beta.md'), '---\ndescription: 无 name 字段回退文件名\n---\n正文B');
    writeFileSync(path.join(dirB, 'alpha.md'), '---\nname: alpha\ndescription: 覆盖版描述\n---\n正文A2'); // 后扫目录覆盖
    writeFileSync(path.join(dirB, 'explore.md'), '---\nname: explore\ndescription: 用户自定义 explore 覆盖内置\n---\n自定义正文');

    loadAgents([dirA]);
    const alphaA = AGENTS_REGISTRY.get('alpha')!;
    expect(alphaA.maxTurns).toBe(30);
    expect(alphaA.tools?.join(',')).toBe('read,view');
  });

  it('同名后扫目录覆盖先扫 / 缺 description 跳过 / name 回退文件名 / 覆盖内置', () => {
    loadAgents([dirA, dirB]);
    const alpha = AGENTS_REGISTRY.get('alpha')!;
    expect(alpha.description).toBe('覆盖版描述');
    expect(alpha.content).toBe('正文A2');
    expect(AGENTS_REGISTRY.has('nodescription')).toBe(false);
    expect(AGENTS_REGISTRY.get('beta')?.name).toBe('beta');
    expect(AGENTS_REGISTRY.get('explore')?.description).toBe('用户自定义 explore 覆盖内置');
  });

  it('frontmatter reportMarker 解析', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'leow3bot-agents-rm-'));
    try {
      writeFileSync(path.join(d, 'contract.md'), '---\nname: contract\ndescription: 契约测试\nreportMarker: "## 报告"\n---\n正文');
      loadAgents([d]);
      expect(AGENTS_REGISTRY.get('contract')?.reportMarker).toBe('## 报告');
    } finally {
      loadAgents([]); // 恢复仅内置，供后续测试
      rmSync(d, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    loadAgents([]); // 恢复仅内置
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });
});

// ============================================================
// 2. buildToolset：过滤 / 强制剔除 / 未知工具 / 只读判定
// ============================================================
describe('工具集组装', () => {
  const explore = AGENTS_REGISTRY.get('explore')!;

  it('explore 白名单过滤，无错误', () => {
    const ts = buildToolset(explore);
    expect(ts.error).toBeUndefined();
    const keys = Object.keys(ts.registry).sort().join(',');
    expect(keys).toBe('bash,read,skill,view,web_fetch,web_search');
  });

  it('ask/subagent 强制剔除（白名单写了也无效）', () => {
    const forceRemove = buildToolset({ ...explore, tools: ['read', 'ask', 'subagent'] });
    expect(Object.keys(forceRemove.registry)).not.toContain('ask');
    expect(Object.keys(forceRemove.registry)).not.toContain('subagent');
  });

  it('未知工具名报错（不静默丢弃）', () => {
    const unknown = buildToolset({ ...explore, tools: ['read', 'nosuchtool'] });
    expect(unknown.error).toBeDefined();
    expect(unknown.error).toContain('nosuchtool');
  });

  it('缺省白名单 = 全量注册表（扣 subagent/ask 强制剔除）', () => {
    const fullSet = buildToolset({ ...explore, tools: undefined });
    expect(Object.keys(fullSet.registry).length).toBe(Object.keys(TOOLS_REGISTRY).length - 2);
  });
});

// ============================================================
// 3. 只读闸（方案 B）
// ============================================================
describe('只读 bash 闸', () => {
  const ts = buildToolset(AGENTS_REGISTRY.get('explore')!);
  const exploreBash = ts.registry['bash'];

  it.each([
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
  ])('拦截 ← %s', async (cmd) => {
    const r = await exploreBash.function({ command: cmd }) as { type?: string; message?: string };
    expect(r.type).toBe('error');
    expect(r.message ?? '').toContain('只读代理禁止写操作');
  });

  it.each([
    'grep -rn leow3bot src',
    'ls -la',
    'find . -name "*.ts" 2>/dev/null',
    'echo guard-ok-12345',
  ])('放行 ← %s', async (cmd) => {
    const r = await exploreBash.function({ command: cmd }) as { type?: string };
    expect(r.type).toBe('bash');
  });

  it('含 write 的代理 bash 不受只读闸限制', async () => {
    const writable = buildToolset({ ...AGENTS_REGISTRY.get('explore')!, name: 'writer', tools: ['read', 'write', 'bash'] });
    const wR = await writable.registry['bash'].function({ command: 'echo guard-ok-12345' }) as { output?: string };
    expect(wR.output ?? '').toContain('guard-ok-12345');
  });
});

// ============================================================
// 4. 模型解析 + 重复派发（顺序依赖：dispatchHistory 全局）
// ============================================================
describe('模型解析与重复派发', () => {
  it('agent 定义 model 最优先', () => {
    expect(resolveSubagentModel({ ...AGENTS_REGISTRY.get('explore')!, model: 'custom-model' })).toBe('custom-model');
  });

  it('回退顺序：/subagent 配置 > 继承主模型', () => {
    expect(resolveSubagentModel(AGENTS_REGISTRY.get('explore')!)).toBe(getSubagentModel() ?? MODEL);
  });

  it('首次派发放行（查不记）', () => {
    expect(checkDuplicateDispatch('task-A 首次派发')).toBeNull();
  });

  it('只查不记：未 record 的文本反复查都不警告', () => {
    expect(checkDuplicateDispatch('task-A 首次派发')).toBeNull();
  });

  it('记录后同文本警告 / 不同文本不受影响', () => {
    recordDispatch('task-A 首次派发');
    expect(checkDuplicateDispatch('task-A 首次派发')).not.toBeNull();
    expect(checkDuplicateDispatch('task-B 不同任务')).toBeNull();
  });
});

// ============================================================
// 5. packageResult：截断 / 空输出 / 错误 / 状态内带 / 结构契约
// ============================================================
describe('结果包装', () => {
  const explore = AGENTS_REGISTRY.get('explore')!;

  it('超长报告截断 + 落盘提示', () => {
    const longText = '## 概览\n' + 'x'.repeat(5000);
    const pr = packageResult(explore, { status: 'done', finalText: longText, rounds: 3, toolCalls: 2, usage: null, error: null }, undefined, 'm1') as Record<string, unknown>;
    expect((pr.report as string).length).toBeLessThan(5100);
    expect(pr.report as string).toContain('已保存至');
  });

  it('报告正文首行状态内带 / ⎿ 摘要格式', () => {
    const pr = packageResult(explore, { status: 'done', finalText: '## 概览\nok', rounds: 3, toolCalls: 2, usage: null, error: null }, undefined, 'm1') as Record<string, unknown>;
    expect(pr.report as string).toMatch(/^\[子代理 explore · 完成（3 轮\/2 次工具）\]/);
    expect(pr.output as string).toMatch(/^完成（3 轮\/2 次工具）/);
  });

  it('done 但零输出 → 如实报错', () => {
    const empty = packageResult(explore, { status: 'done', finalText: '  ', rounds: 3, toolCalls: 2, usage: null, error: null }, undefined, 'm1') as { type?: string };
    expect(empty.type).toBe('error');
  });

  it('error 状态 → 错误结果', () => {
    const errRes = packageResult(explore, { status: 'error', finalText: '部分输出', rounds: 1, toolCalls: 0, usage: null, error: 'HTTP 500' }, undefined, 'm1') as { type?: string; message?: string };
    expect(errRes.type).toBe('error');
    expect(errRes.message ?? '').toContain('HTTP 500');
  });

  it('进度旁白伪装报告 → 契约拦截为未完成', () => {
    const narration = packageResult(explore, { status: 'done', finalText: '✓ 第 7 页已读：……继续第 8 页：', rounds: 8, toolCalls: 12, usage: null, error: null }, undefined, 'm1') as { type?: string; message?: string };
    expect(narration.type).toBe('error');
    expect(narration.message ?? '').toContain('提前停止');
  });

  it('无契约定义不校验格式', () => {
    const noMarkerDef = { ...explore, name: 'free', reportMarker: undefined };
    const free = packageResult(noMarkerDef, { status: 'done', finalText: '纯文本结论', rounds: 2, toolCalls: 1, usage: null, error: null }, undefined, 'm1') as { type?: string; report?: string };
    expect(free.type).toBe('task');
    expect(free.report as string).toContain('纯文本结论');
  });

  it('interrupted 报告标注不完整', () => {
    const intRes = packageResult(explore, { status: 'interrupted', finalText: '## 概览\n部分内容', rounds: 5, toolCalls: 3, usage: null, error: null }, undefined, 'm1') as { report?: string };
    expect(intRes.report as string).toContain('被中断');
  });
});

// ============================================================
// 6. runAgentLoop 假流集成：完整子代理生命周期
// ============================================================
describe('runAgentLoop 假流集成（streamFn 注入）', () => {
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

  it('完整生命周期：轮次/工具计数/消息契约/静默隔离/usage 累加', async () => {
    let ri = 0;
    const streamFn: typeof import('../../src/llm.js').callLLMStream = async function* () {
      for (const ev of rounds[ri++] ?? []) yield ev;
    };
    const loopMessages: MessageParam[] = [{ role: 'user', content: '测试任务' }];
    let sinkEvents = 0;
    const countingSink: AgentLoopSink = { ...SILENT_SINK, event: () => { sinkEvents++; } };
    const loopResult = await runAgentLoop({ current: null }, {
      messages: loopMessages, system: '测试 system', tools: [fakeTool.schema], registry: { probe: fakeTool },
      maxRounds: 5, sink: countingSink, autosave: false, streamFn,
    });
    expect(loopResult.status).toBe('done');
    expect(loopResult.finalText).toBe('报告：探查完成');
    expect(loopResult.rounds).toBe(2);
    expect(loopResult.toolCalls).toBe(1);
    expect(loopMessages.length).toBe(4); // user→assistant→tool_result→assistant
    const trMsg = loopMessages[2];
    const trBlock = (Array.isArray(trMsg.content) ? trMsg.content[0] : null) as ToolResultBlock | null;
    expect(trBlock?.type).toBe('tool_result');
    expect(trBlock?.tool_use_id).toBe('t1'); // tool_result 紧随 tool_use（Anthropic 契约）
    expect(sinkEvents).toBe(2); // 只收到 tool_start + tool_result 两个事件（静默隔离）
    expect((loopResult.usage as { output_tokens?: number }).output_tokens).toBe(13); // usage 累加（5+8）
  });
});

// ============================================================
// 7. 状态面板 sink（动态区可见性）
// ============================================================
describe('状态面板 sink', () => {
  it('tool_start 更新 activity 与计数，usage 触发轮数计，结束移除面板行', () => {
    const panelKey = `test-panel-${Date.now()}`;
    ssStart({ key: panelKey, name: 'explore', desc: '测试面板', rounds: 0, toolCalls: 0, activity: '启动中…', startedAt: Date.now() });
    const panelSink = makeSubagentSink(panelKey);
    panelSink.event({ kind: 'tool_start', call: { id: 'x', name: 'bash', input: { command: 'grep -rn auth src/' } } });
    panelSink.event({ kind: 'tool_result', call: { id: 'x', name: 'bash', input: {} }, result: {} });
    panelSink.usage({ input_tokens: 1 }, { ttft: 1, decode_time: 1, total: 1 });
    const entry = getStoreState().subagents.find(x => x.key === panelKey)!;
    expect(entry?.activity).toBe('bash: grep -rn auth src/');
    expect(entry?.toolCalls).toBe(1); // tool_result 不计
    expect(entry?.rounds).toBe(1);
    ssEnd(panelKey);
    expect(getStoreState().subagents.some(x => x.key === panelKey)).toBe(false);
  });
});

// ============================================================
// 8. bash 进程组回收（leo 退出不留守孤儿）
// ============================================================
describe('bash 进程组回收', () => {
  it('exit 钩子组杀后孙进程（sleep）已死，无孤儿', async () => {
    const bashTool = TOOLS_REGISTRY['bash']!;
    // 用独特的 sleep 时长防与环境中其他 sleep 撞车（ps 按此过滤）
    const p1 = bashTool.function({ command: 'sh -c "sleep 297"', timeout: 300 }) as Promise<{ type?: string }>;
    await new Promise(r => setTimeout(r, 400)); // 等 spawn 注册进 ACTIVE_BASH_PGIDS
    killActiveBash(); // 模拟 main.tsx 的 exit 钩子
    const r1 = await p1;
    expect(r1.type).toBe('bash'); // 组杀后命令正常返回结果
    await new Promise(r => setTimeout(r, 400)); // 等僵尸回收
    const { execSync } = await import('node:child_process');
    let alive = '';
    try { alive = execSync('ps -eo pid,cmd | grep "sleep 297" | grep -v grep || true').toString(); } catch { /* ps 空 */ }
    expect(alive.includes('sleep 297')).toBe(false);
  }, 15_000);
});

// ============================================================
// 9. 工具打点 + 子代理语境语义（interactive=false）
// ============================================================
describe('工具打点与子代理语境', () => {
  it('执行中工具登记打点行，完成移除', async () => {
    const slowTool: ToolDef = {
      function: () => new Promise(r => setTimeout(() => r({ type: 'text', content: '慢工具完成' }), 1200)),
      concurrencySafe: true,
      schema: { name: 'slowprobe', description: '慢探针', input_schema: { type: 'object', properties: {}, required: [] } },
    };
    const pSlow = executeTool('slowprobe', {}, { slowprobe: slowTool });
    await new Promise(r => setTimeout(r, 300));
    const row = getStoreState().runningTools.find(x => x.name === 'slowprobe');
    expect(row?.summary).toBe(''); // 无代表性入参则摘要为空
    const rSlow = await pSlow as { content?: string };
    expect(rSlow.content).toBe('慢工具完成');
    expect(getStoreState().runningTools.some(x => x.name === 'slowprobe')).toBe(false);
  }, 10_000);

  it('deny 黑名单在子代理语境照常生效', async () => {
    const rDeny = await executeTool('bash', { command: 'rm -rf /' }, TOOLS_REGISTRY, false) as { type?: string; message?: string };
    expect(rDeny.type).toBe('error');
    expect(rDeny.message ?? '').toContain('权限管控');
  });

  it('interactive=false 不登记通用打点行（专属行已覆盖）', async () => {
    const before = getStoreState().runningTools.length;
    const rQuiet = await executeTool('bash', { command: 'echo x' }, TOOLS_REGISTRY, false) as { type?: string };
    expect(rQuiet.type).toBe('bash');
    expect(getStoreState().runningTools.length).toBe(before);
  });
});

// ============================================================
// 10. 并发信号量（超额排队而非拒绝）
// ============================================================
describe('并发信号量', () => {
  it(`5 路并发被限流且确实并行`, async () => {
    let cur = 0;
    let peak = 0;
    const task = async () => {
      cur++;
      peak = Math.max(peak, cur);
      await new Promise(r => setTimeout(r, 80));
      cur--;
    };
    await Promise.all(Array.from({ length: 5 }, () => withSlot(task)));
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_SUBAGENTS);
    expect(peak).toBeGreaterThanOrEqual(2); // 非串行
  });
});

// ============================================================
// 11. TDD 补测：未覆盖行为
// ============================================================
describe('入口活体与护栏', () => {
  it('注册表入口可调用：短 prompt 拒发（import 环无运行时崩溃）', async () => {
    const subEntry = TOOLS_REGISTRY['subagent']!;
    const subTooShort = await subEntry.function({ prompt: '太短' }) as { type?: string; message?: string };
    expect(subTooShort.type).toBe('error');
    expect(subTooShort.message ?? '').toContain('过短');
  });

  it('未知类型报错且列出可用类型', async () => {
    const subEntry = TOOLS_REGISTRY['subagent']!;
    const subUnknown = await subEntry.function({ prompt: '查询这个项目里所有处理鉴权的代码位置', agent_type: 'nosuch' }) as { type?: string; message?: string };
    expect(subUnknown.type).toBe('error');
    expect(subUnknown.message ?? '').toContain('未知子代理类型');
  });

  it('外部已中止 → 零 LLM 调用返回 interrupted', async () => {
    let llmCalls = 0;
    const sf: typeof import('../../src/llm.js').callLLMStream = async function* () { llmCalls++; };
    const aborted = new AbortController();
    aborted.abort();
    const res = await runAgentLoop({ current: null }, {
      messages: [{ role: 'user', content: '任务' }], system: 's', tools: [], registry: {},
      maxRounds: 5, sink: SILENT_SINK, autosave: false, externalSignal: aborted.signal, streamFn: sf,
    });
    expect(res.status).toBe('interrupted');
    expect(llmCalls).toBe(0);
  });

  it('子代理 system 组装：正文在前 + 环境块 + web 指引', () => {
    const explore = AGENTS_REGISTRY.get('explore')!;
    const ts = buildToolset(explore);
    const sys = buildSubagentSystem(explore, ts.registry);
    expect(sys.startsWith(explore.content.slice(0, 30))).toBe(true);
    expect(sys).toContain('## 环境');
    expect(sys).toContain(process.cwd());
    expect(sys).toContain('web_search');
  });

  it('未启动的任务重发不误伤（护栏期不记录重复派发）', async () => {
    const explore = AGENTS_REGISTRY.get('explore')!;
    const broken = { ...explore, name: 'broken', tools: ['read', 'nosuchtool'] };
    AGENTS_REGISTRY.set('broken', broken);
    try {
      const P = '这是一条足够长的测试任务描述，用于验证未启动的任务不记录重复派发';
      const r1 = await runSubagent({ prompt: P, agent_type: 'broken' }) as { type?: string; message?: string };
      expect(r1.type).toBe('error');
      expect(r1.message ?? '').toContain('nosuchtool'); // 前提：工具集报错，任务从未启动
      const r2 = await runSubagent({ prompt: P, agent_type: 'broken' }) as { type?: string; message?: string };
      expect(r2.message ?? '').not.toContain('疑似重复派发');
    } finally {
      AGENTS_REGISTRY.delete('broken');
    }
  });
});

describe('自主搜索纠偏（主对话语境注入，子代理语境不注入）', () => {
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

  it('连续 4 轮自主搜索 → 恰好注入 1 次提示，且在第 4 轮最后一个结果尾部', async () => {
    let ri = 0;
    const rs = makeRounds();
    const sf: typeof import('../../src/llm.js').callLLMStream = async function* () { for (const ev of rs[ri++] ?? []) yield ev; };
    const msgs: MessageParam[] = [{ role: 'user', content: '搜' }];
    const res = await runAgentLoop({ current: null }, {
      messages: msgs, system: 's', tools: [readTool.schema], registry: reg,
      maxRounds: 10, sink: SILENT_SINK, autosave: false, streamFn: sf,
    });
    expect(res.status).toBe('done');
    expect(countHints(msgs)).toBe(1);
    const r4 = msgs[8]; // 第 4 轮 tool_result 所在 user 消息
    const r4blocks = Array.isArray(r4.content) ? r4.content : [];
    const lastC = String((r4blocks[r4blocks.length - 1] as { content?: unknown } | undefined)?.content ?? '');
    expect(lastC).toContain('[提示]');
    expect(lastC).toContain('连续 4 轮');
  });

  it('子代理语境（interactive=false）不注入纠偏提示', async () => {
    let ri2 = 0;
    const rs2 = makeRounds();
    const sf2: typeof import('../../src/llm.js').callLLMStream = async function* () { for (const ev of rs2[ri2++] ?? []) yield ev; };
    const msgs2: MessageParam[] = [{ role: 'user', content: '搜' }];
    await runAgentLoop({ current: null }, {
      messages: msgs2, system: 's', tools: [readTool.schema], registry: reg,
      maxRounds: 10, sink: SILENT_SINK, autosave: false, interactive: false, streamFn: sf2,
    });
    expect(countHints(msgs2)).toBe(0);
  });
});

describe('图片类 400 毒化恢复', () => {
  it('图片 payload 错误按可重试处理 → 重试后恢复，而非 status=error 终止', async () => {
    let llmCalls = 0;
    const sf: typeof import('../../src/llm.js').callLLMStream = async function* () {
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
    expect(res.status).toBe('done');
    expect(llmCalls).toBe(2);
  });
});
