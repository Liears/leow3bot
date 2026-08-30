# leow3bot

终端里的 AI 编程助手——TypeScript + ink 构建，连接智谱 BigModel（glm-5.x）。自然语言下达任务，它自主调用工具完成：读写文件、执行命令、查看图片、联网搜索，全程流式输出。

## 安装

### 环境要求

- **Node.js ≥ 20**
- **智谱 BigModel API Key**（[获取](https://open.bigmodel.cn)）

### npm 安装

```bash
npm install -g @leow3lab/leow3bot
leow3bot
```

### 从源码安装

```bash
git clone https://github.com/yuanhechen/leow3bot.git
cd leow3bot
npm install
npm install -g .        # 注册全局 leow3bot 命令
```

安装完成后，在任意目录输入 `leow3bot` 启动。开发调试也可不装全局，在仓库目录直接 `npm start`。

### 开发

```bash
npm start               # tsx 直接运行源码
npm run build           # tsup 打包 → dist/main.mjs
npm test                # 类型检查 + 渲染/状态/权限测试
```

## 使用

### 首次启动

首次运行 `leow3bot` 会进入四步引导，答完即用，全程无需编辑任何配置文件：

| 步骤 | 说明 |
|---|---|
| ① API 端点 | 回车使用默认智谱端点，或输入自定义端点（自动补全 `https://`，非法输入会被拦截） |
| ② API Key | 粘贴你的智谱 BigModel key（联网搜索默认复用同一 key） |
| ③ 选择模型 | 从端点实时拉取的模型列表中 ↑↓ + Enter 选择（新→旧排列） |
| ④ 上下文窗口 | 输入模型的上下文长度，回车使用默认 `192000` |

配置自动写入 `~/.leow3bot/config.json`。**输出上限（max_tokens）无需填写**——请求超限时自动学习端点限制并按模型记忆，同一模型不会重复撞限。

高级配置（可选）：需要时可手工向 `~/.leow3bot/config.json` 追加 `contextWindow`、`permissions`（命令 deny / confirm 规则，示例见 `config.example.json`）、`systemPrompt`、`thinkingBudget`、`webApiKey`。

### 日常使用

直接用自然语言描述任务，leow3bot 自主选择并组合工具：

| 你说 | 它做 |
|---|---|
| 「这个仓库的入口在哪，梳理下结构」 | 浏览目录、阅读源码，给出结构总结 |
| 「把 config.ts 里的 0.7 改成 0.6」 | 读取定位 → 精确替换（未读过的文件不允许直接改写） |
| 「跑下测试，挂了就修」 | 执行测试 → 分析报错 → 修改 → 重跑，直到通过 |
| 「搜一下 glm-5.2 发布了没」 | 联网搜索，回答附来源链接 |
| 「看看这张截图哪有 bug」 | 视觉查看图片（Ctrl-V 直接粘贴剪贴板截图） |
| 「读一下这份 PDF」 | PDF skill 自动分类：文字型提取为文本，扫描件渲染逐页识别 |

**权限管控**：高危命令（`rm -rf /`、格式化磁盘、fork 炸弹等）命中内置黑名单，直接拒绝不询问。`rm -rf`、`git reset --hard` 这类命令的执行前确认需要自行配置——在 `~/.leow3bot/config.json` 的 `permissions.confirm` 中添加规则（示例见 `config.example.json`），命中时会停下来等你选择：`y` 本次允许 / `a` 允许并记住（写入 `~/.leow3bot/permissions.json`，删对应行即可撤销）/ `n` 拒绝。

### 切换模型

```
❯ /model

  模型切换
  ↑↓ 选择 · Enter 确认 · Esc/q 取消 · 共 10 个（新→旧）
    ▶ ● glm-5.3      — 输出上限 192,000 · 当前
      glm-5.3-flash  — 输出上限 192,000
      ...
```

`/model` 打开交互选择器（模型列表来自端点，切换即时生效并持久化）；`/model glm-5.3` 带模型名直接切换，拼错会先校验并列出可用清单。

### 命令

| 命令 | 作用 |
|---|---|
| `/help` | 列出全部命令 |
| `/model [名称]` | 交互式模型选择器；带名称直接切换并持久化 |
| `/subagent` | 子代理模型选择器（默认跟随主模型） |
| `/context` `/perf` | 开关底部状态栏（上下文占用 / 性能指标） |
| `/verbose` | 展开 / 折叠思考过程 |
| `/compact` | 压缩上下文（图片摘要 + 旧工具结果截断） |
| `/clear` | 清空当前对话 |
| `/save` `/load` `/sessions` | 保存会话 / 加载会话 / 历史会话列表 |
| `/tools` `/skills` `/history` `/status` | 工具 / skill / 历史 / 状态查看 |
| `/q` | 退出 |

### 快捷键

| 按键 | 作用 |
|---|---|
| `Tab` | 斜杠命令补全 |
| `Ctrl-V` | 粘贴剪贴板图片（截图提问） |
| 粘贴多行文本 | 自动折叠为 `[Pasted text #1 +17 lines]`，提交时还原完整内容；超长粘贴自动落盘并截断 |
| `Esc` | 中断正在生成的回复（保留已生成部分）；子代理运行中一并中止 |
| `q` | 退出 |

### 会话恢复

对话自动保存。重新打开时：

```bash
leow3bot -r             # 交互式选择历史会话
leow3bot -r <会话id>     # 恢复指定会话
leow3bot -c             # 恢复当前项目最近一次会话
```

恢复时自动切换回会话当时的工作目录，上下文完整续接。

### skill 扩展

leow3bot 自动扫描以下目录中的 `<name>/SKILL.md`（后者覆盖前者同名）：

- `~/.claude/skills/` — Claude 生态标准位置（`npx skills add` 默认安装处）
- `~/.leow3bot/skills/` — leow3bot 专属目录
- `./.claude/skills/` — 项目级

```bash
npx skills add https://github.com/vercel-labs/skills --skill find-skills
```

PDF skill（文字型提取 markdown / 扫描件渲染识别，依赖自动安装）为本地资产，不随仓库分发——将 `skills/pdf/` 目录放入上述任一位置即可启用。用 `/skills` 查看与开关已加载的 skill。

### 子代理（subagent）

主模型可把广度型调查委派给子代理：子代理在独立上下文中运行，内部过程不进主对话，只返回压缩报告。一轮并行发出多个 subagent 调用即并行执行（上限 3）。推荐节奏：先并行侦察拿全局概览，再亲自精读关键处——委派广度，亲为深度。

- 内置 `explore`：只读搜索代理（广度扇出搜索，bash 带写操作拦截），跨多文件定位、梳理结构、大目录探查
- 自定义子代理与 skill 同格式（frontmatter：`name` / `description` / `tools` / `model` / `maxTurns`，正文 = 子代理 system prompt），放入以下任一目录即生效（后者覆盖前者）：
  - `~/.claude/agents/` — Claude Code 生态标准位置，现有 agent 文件直接可用
  - `~/.leow3bot/agents/` — leow3bot 专属目录
  - `./.claude/agents/` — 项目级
- 子代理模型默认跟随主模型，`/subagent` 命令显式指定并持久化（agent 定义自带 `model` 的优先）
- 更多示例（analyst 批量文档分析 / reviewer 代码审查 / researcher 联网调研）见 `docs/agents-examples/`，复制到上述目录即可启用
- 设计文档：`docs/subagent-design.md`
