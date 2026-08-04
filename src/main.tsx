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
import { setSystem, buildSystem, setMessages } from './agent.js';
import { getWelcomeItems } from './commands.js';
import { TOOLS_REGISTRY } from './tools.js';
import { SKILL_DIRS, MODEL } from './config.js';
import { resumeSession, resumeLatest, applyResume } from './session.js';
import type { MessageParam } from './types.js';

// —— 参数解析（仿 Claude Code）：--resume <id> / -r [id] / --continue / -c ——
// -r 带值 → 按 ID 直接恢复；不带值 → 启动时弹交互式会话选择器
const args = process.argv.slice(2);
let resumed: { messages: MessageParam[]; filepath: string } | null = null;
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

loadSkills(SKILL_DIRS);
setSystem(buildSystem());

setMeta({
  model: MODEL,
  nTools: Object.keys(TOOLS_REGISTRY).length,
  nSkills: SKILLS_REGISTRY.size,
  cwd: process.cwd(),
});
for (const item of getWelcomeItems()) commit(item);

if (resumed) {
  // 完全恢复：消息进上下文 + 历史重建进 committed（UI 可见，与流式渲染一致）
  setMessages(resumed.messages);
  applyResume(resumed.messages);
  commit({
    kind: 'system', tone: 'ok',
    text: `✓ 已恢复会话 ${resumed.filepath.split('/').pop()}（${resumed.messages.length} 条消息）`,
  });
} else if (picker) {
  setPhase('session_picker'); // render 前设置，App 首帧即选择器
}

render(React.createElement(App));
