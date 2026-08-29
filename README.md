# leow3bot

CLI AI agent，**TypeScript + ink**，对标 Claude Code 的终端渲染。连接智谱 BigModel 的 Anthropic 兼容端点（glm-5.x），支持工具调用、流式输出、skill、会话存储、剪贴板图片粘贴、联网搜索/阅读。

## 特性

- **流式逐字 + 底部状态栏常驻 + 鼠标滚轮翻原生 scrollback** 三者兼得 —— ink `<Static>` + 动态区 diff，对标 Claude Code
- **9 工具**：`bash` / `read` / `view`（看图） / `write` / `edit` / `skill` / `ask` / `web_search`（智谱搜索） / `web_fetch`（纯客户端抓取）
- 流式思考（默认折叠，`/verbose` 展开）
- ESC 中断流式（AbortController）
- 15 斜杠命令 + Tab 补全
- Ctrl-V 粘贴剪贴板图片
- skill 系统（兼容社区 `npx skills add`）+ 会话自动保存/加载
- 跨平台剪贴板（WSL2 / Linux / macOS / Windows）

## 快速开始

### 安装（源码）
```bash
git clone https://github.com/yuanhechen/leow3bot.git
cd leow3bot
npm install
npm install -g .        # 注册全局命令；开发态也可直接 npm start
```

### 首次启动（零手工配置）
```bash
leow3bot               # 任意目录启动
```
首次启动进入四步引导：API 端点（回车 = 默认智谱端点）→ API Key → 从列表选择模型（`/v1/models` 实时拉取，↑↓ + Enter）→ 输入上下文窗口长度（回车 = 默认 192000）。配置自动写入 `~/.leow3bot/config.json`，联网搜索默认复用同一 key——无需编辑任何文件。max_tokens 输出上限无需填写，超限报错时自动学习并按模型记忆；切换模型用 `/model`（交互选择器，即时生效并持久化）。

> npm 全局安装（`npm install -g @yuanhechen/leow3bot`）待包发布后启用。

### 高级配置（可选）
`~/.leow3bot/config.json` 可按需手工追加字段：`contextWindow`、`permissions`（deny / confirm 规则，记住的允许持久化在 `~/.leow3bot/permissions.json`，示例见 `config.example.json`）、`systemPrompt`（覆盖内置系统提示词）、`thinkingBudget`（思考预算，默认 5000）、`webApiKey`（搜索用独立 key，默认复用 apiKey）。

### 开发
```bash
npm install
npm start              # tsx 直接跑源码
npm run build          # tsup 打包 → dist/main.mjs
npm install -g .       # 本地全局安装测试
```

输入 `q` 退出，或 Ctrl-C。

## 命令

| 命令 | 作用 |
|---|---|
| `/help` | 列出命令 |
| `/context` `/perf` | 开关底部状态栏（context / perf 指标）|
| `/verbose` | 展开 / 折叠思考内容 |
| `/clear` | 清空对话 |
| `/tools` `/skills` `/history` `/status` | 信息查看 |
| `/model [名称]` | 交互式模型选择器（↑↓ + Enter）；`/model glm-5.3` 直接切换并持久化 |
| `/save` `/load` `/sessions` | 会话保存 / 加载 / 列表 |
| `/compact` | 压缩上下文（媒体 + 旧工具结果）|
| `/q` | 退出 |

**交互**：`Tab` 补全命令；`Ctrl-V` 粘贴剪贴板图片；`ESC` 中断流式。

## skill 系统

leow3bot 自动扫描三个目录的 `<name>/SKILL.md`：
- `~/.claude/skills/` — `npx skills add` 默认装这（Claude 用户级标准）
- `~/.leow3bot/skills/` — leow3bot 自己的 home
- `./.claude/skills/` — 项目级（优先级最高，覆盖同名）

```bash
npx skills add https://github.com/vercel-labs/skills --skill find-skills
leow3bot    # 自动发现并可用 find-skills
```

> PDF skill（分类路由：文字型提取 markdown、扫描型渲染成图，pip 依赖自举）为本地资产，不随仓库分发——把 `skills/pdf/` 放入上面任一目录即可启用。

## 架构

| 维度 | 选择 |
|---|---|
| 运行时 | Node.js ≥20；开发用 tsx，发布用 tsup bundle |
| UI | ink 5 + react 18，`<Static>` 复刻 CC scrollback |
| LLM | `@anthropic-ai/sdk` 配 Anthropic 兼容端点 |
| 状态 | `createStore` + `useSyncExternalStore`（CC 风格）|
| 图片 | sharp（替代 PIL）|
| web | 智谱 web_search + 纯客户端 web_fetch（turndown）|

核心模块：`config.ts`（配置+运行时切换）/ `llm.ts`（流式+自适应）/ `agent.ts`（轮次循环+探测）/ `tools.ts`（9 工具）/ `store.ts`（CC 风格状态）/ `websearch.ts`、`executor.ts`、`skills.ts`、`session.ts`、`compaction.ts`。

## 验证脚本

```bash
npm run probe        # 验证端点流式兼容（流式 + usage/timing）
npm run typecheck    # tsc 类型检查
npm test             # typecheck + markdown/store/app 测试
```

## 状态栏

底部状态栏（`/context` `/perf` 开启）：
- **context**：占用进度条 + 百分比
- **perf**：输入/输出 token、TTFT、TPOT、decode tok/s

流式期间状态栏**常驻不消失**（在动态区，每帧 diff）—— 这是换 ink 的核心收益。
