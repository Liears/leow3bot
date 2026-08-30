// leow3bot 入口：loadSkills + welcome 进 committed + render(<App/>)。
// 退出：q / Ctrl-C（ink 默认 exitOnCtrlC）。
//
// 启动参数（仿 Claude Code）：
//   leow3bot --resume <会话id>   完全恢复指定会话（id = sessions 文件名，可带可不带 .json）
//   leow3bot --continue          恢复当前项目最近会话（autosave 或最近快照）
//   无参数                       新会话

import React from 'react';
import { render } from 'ink';
import App from './components/App.js';
import { commit, setMeta, setPhase } from './store.js';
import { loadSkills, SKILLS_REGISTRY } from './skills.js';
import { loadAgents, AGENTS_REGISTRY } from './subagents/loader.js';
import { setSystem, buildSystem, probeWebSearchAvailability, autoDetectModel } from './agent.js';
import { getWelcomeItems } from './commands.js';
import { TOOLS_REGISTRY } from './tools.js';
import { killActiveBash } from './tools.js';
import { getSkillDirs, getAgentDirs, MODEL, getApiKey } from './config.js';
import { resumeSession, resumeLatest, activateResume, setSessionTitle } from './session.js';
import { initTitleState } from './title.js';
import type { MessageParam } from './types.js';

// —— 参数解析（仿 Claude Code）：--resume <id> / -r [id] / --continue / -c ——
// -r 带值 → 按 ID 直接恢复；不带值 → 启动时弹交互式会话选择器
const args = process.argv.slice(2);
let resumed: { messages: MessageParam[]; filepath: string; projectRoot: string; name: string } | null = null;
let picker = false;
if (args[0] === '--resume' || args[0] === '-r') {
  const id = args[1];
  if (id && !id.startsWith('-')) {
    resumed = resumeSession(id);
    if (!resumed) {
      console.error(`✗ 找不到会话: ${id}（用 leow3bot -r 查看会话列表）`);
      process.exit(1);
    }
  } else {
    picker = true; // 无 ID → 交互式选择器
  }
} else if (args[0] === '--continue' || args[0] === '-c') {
  resumed = resumeLatest();
  if (!resumed) {
    console.error('✗ 没有可恢复的会话（当前项目无 autosave/快照）');
    process.exit(1);
  }
}

loadSkills(getSkillDirs());
loadAgents(getAgentDirs()); // agent 定义先于 buildSystem 加载（菜单注入用）
setSystem(buildSystem());

// 首次启动引导：加载链（~/.leow3bot → 项目根 config.json）走完仍无 apiKey =
// 新用户 → 进入 onboarding 表单（端点 + key），完成后自动生成配置，无需重启。
// 开发态在 repo 根有 config.json 的不会误触。
if (!getApiKey()) setPhase('onboarding');

setMeta({
  model: MODEL,
  nTools: Object.keys(TOOLS_REGISTRY).length,
  nSkills: SKILLS_REGISTRY.size,
  cwd: process.cwd(),
});
for (const item of getWelcomeItems()) commit(item);

if (resumed) {
  // 完全恢复：chdir 到会话所属项目（如不同）+ 消息进上下文 + 历史重建进 committed
  const prevCwd = process.cwd();
  setSessionTitle(resumed.name); // 主题更新基准 = 会话文件里的主题
  initTitleState(resumed.messages); // 主题节流基准 = 当前 user 消息数（避免首轮立即重生成）
  activateResume(resumed);
  const cwdChanged = process.cwd() !== prevCwd;
  if (cwdChanged) {
    loadSkills(getSkillDirs()); // 项目级 skill 按新目录重扫
    loadAgents(getAgentDirs()); // 项目级 agent 定义同理
    setSystem(buildSystem()); // 重建系统提示词（skill/agent 列表随新目录变化）
    setMeta({ model: MODEL, nTools: Object.keys(TOOLS_REGISTRY).length, nSkills: SKILLS_REGISTRY.size, cwd: process.cwd() }); // 状态栏显示新目录
  }
  commit({
    kind: 'system', tone: 'ok',
    text: `✓ 已恢复会话 ${resumed.filepath.split('/').pop()}（${resumed.messages.length} 条消息）` +
      (cwdChanged ? `，工作目录已切换: ${process.cwd()}` : ''),
  });
} else if (picker && getApiKey()) {
  // 未配置（onboarding 未完成）时不进选择器——session_picker 会覆盖 onboarding
  // phase，新用户直进空 key 对话（code-review F1）；配置完自然有会话可选
  setPhase('session_picker'); // render 前设置，App 首帧即选择器
}

// 进程回收钩子：TUI raw mode 下 Ctrl-C 不向子进程发 SIGINT，leo 退出时
// 运行中的 bash 命令（含孙进程）不回收会变孤儿（实测安静的 python 任务
// 不撞 SIGPIPE 会一直活着）。killActiveBash 按进程组 SIGKILL，同步可exit内执行。
process.on('exit', () => killActiveBash());

// web_search 可用性探测（fire-and-forget 不阻塞启动）。onboarding 未完成
// （apiKey 为空）时跳过——空 key 必失败会误杀 web_search 且事后无法恢复，
// onboarding 填完 key 后由 App 侧补探测。
// 模型自动选型同理仅在有 key 时跑；未显式配置 model 才探测（/v1/models 过滤
// 轻量变体后取最新旗舰，写回 config 固化，/model 随时可改）。
if (getApiKey()) {
  void probeWebSearchAvailability();
  void autoDetectModel();
}

render(React.createElement(App));
