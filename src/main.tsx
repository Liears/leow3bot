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
import { setSystem, buildSystem } from './agent.js';
import { getWelcomeItems } from './commands.js';
import { TOOLS_REGISTRY, disableTool } from './tools.js';
import { searchWeb } from './websearch.js';
import { getSkillDirs, MODEL, API_BASE_URL, getApiKey, getWebApiKey } from './config.js';
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
setSystem(buildSystem());

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
    setSystem(buildSystem()); // 重建系统提示词（skill 列表随新目录变化）
    setMeta({ model: MODEL, nTools: Object.keys(TOOLS_REGISTRY).length, nSkills: SKILLS_REGISTRY.size, cwd: process.cwd() }); // 状态栏显示新目录
  }
  commit({
    kind: 'system', tone: 'ok',
    text: `✓ 已恢复会话 ${resumed.filepath.split('/').pop()}（${resumed.messages.length} 条消息）` +
      (cwdChanged ? `，工作目录已切换: ${process.cwd()}` : ''),
  });
} else if (picker) {
  setPhase('session_picker'); // render 前设置，App 首帧即选择器
}

// web_search 可用性探测（fire-and-forget 不阻塞启动）：不可用则从工具集移除并重建
// system（不再宣传该工具），避免模型反复调用失败。
// 凭据守卫：端点非智谱且未显式配 webApiKey 时，apiKey 是第三方供应商的 key——
// 不发探测请求（避免把第三方 key 以 Bearer 形式发给 open.bigmodel.cn）。
void (async () => {
  const webKeyExplicit = getWebApiKey() !== getApiKey();
  const disableWith = (text: string) => {
    if (!disableTool('web_search')) return;
    setSystem(buildSystem()); // 重建 system，移除 web_search 宣传
    commit({ kind: 'system', tone: 'warn', text });
  };
  if (!webKeyExplicit && !API_BASE_URL.includes('bigmodel')) {
    disableWith('⚠️ web_search 未启用（当前端点非智谱且未配置 webApiKey，已跳过探测避免凭据外发）——已从工具集移除。如需联网搜索，请在 config.json 配置智谱 webApiKey');
    return;
  }
  try {
    const r = await searchWeb('连通性检测', { count: 1 });
    const ok = String(r.output ?? '').startsWith('搜索 "');
    if (!ok) disableWith(`⚠️ web_search 不可用（${String(r.output ?? '').slice(0, 60)}）——已从工具集移除。如需联网搜索，请在 config.json 配置智谱 webApiKey`);
  } catch {
    disableWith('⚠️ web_search 不可用（网络异常）——已从工具集移除');
  }
})();

render(React.createElement(App));
