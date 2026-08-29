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

### 全局安装
```bash
npm install -g @yuanhechen/leow3bot
leow3bot
```

### 配置
复制 `config.example.json` → `~/.leow3bot/config.json`，填你的智谱 BigModel apiKey：
```json
{
  "apiBaseUrl": "https://open.bigmodel.cn/api/anthropic",
  "apiKey": "你的智谱 key",
  "model": "glm-5.1"
}
```
支持 `permissions`（deny / confirm 规则，命中 confirm 交互确认，记住的允许持久化在 `~/.leow3bot/permissions.json`），见 `config.example.json` 与 `CLAUDE.md`。

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
| `/tools` `/skills` `/model` `/history` `/status` | 信息查看 |
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

本仓库自带 `skills/pdf/`（PDF 分类路由：文字型提取 markdown、扫描型渲染成图，pip 依赖自举安装）。它不随 npm 包分发——从源码使用时拷贝或软链到上面任一目录即可：
```bash
cp -r skills/pdf ~/.leow3bot/skills/pdf
```

## 架构

| 维度 | 选择 |
|---|---|
| 运行时 | Node.js ≥18.19；开发用 tsx，发布用 tsup bundle |
| UI | ink 5 + react 18，`<Static>` 复刻 CC scrollback |
| LLM | `@anthropic-ai/sdk` 配 Anthropic 兼容端点 |
| 状态 | `createStore` + `useSyncExternalStore`（CC 风格）|
| 图片 | sharp（替代 PIL）|
| web | 智谱 web_search + 纯客户端 web_fetch（turndown）|

核心模块见 `CLAUDE.md`。

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
