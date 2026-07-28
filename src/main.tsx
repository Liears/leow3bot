// leow3bot 入口：loadSkills + welcome 进 committed + render(<App/>)。
// 退出：q / Ctrl-C（ink 默认 exitOnCtrlC）。

import React from 'react';
import { render } from 'ink';
import App from './components/App.js';
import { commit, setMeta } from './store.js';
import { loadSkills, SKILLS_REGISTRY } from './skills.js';
import { setSystem, buildSystem } from './agent.js';
import { getWelcomeItems } from './commands.js';
import { TOOLS_REGISTRY } from './tools.js';
import { SKILL_DIRS, MODEL } from './config.js';

loadSkills(SKILL_DIRS);
setSystem(buildSystem());

setMeta({
  model: MODEL,
  nTools: Object.keys(TOOLS_REGISTRY).length,
  nSkills: SKILLS_REGISTRY.size,
  cwd: process.cwd(),
});
for (const item of getWelcomeItems()) commit(item);

render(React.createElement(App));
