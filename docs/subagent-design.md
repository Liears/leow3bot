# leow3bot SubAgent 设计方案（v1）

> 状态：设计定稿，分支 `feat/subagent`。本文档是十余轮设计讨论的沉淀，按「理论 → 判据 → 机制 → 场景」组织。

## 0. 调研结论（四家对比的采纳清单）

| 采纳点 | 来源 | 落地方式 |
|---|---|---|
| `subagent` 工具 + 单报告回传 | DeepAgents | v1 核心：一次委派，一份摘要 |
| md + frontmatter 定义 | Claude Code | 复用 skills 加载器，兼容 `.claude/agents/` 生态 |
| 输出落盘 + 摘要回传 | DA | 复用 `persistToolOutput`，主上下文零污染 |
| 模型配置 | DA（modelRole 简化） | 默认继承主模型；`/subagent` 命令显式选择并持久化 |
| abort 链式取消 | DA | 主对话 ESC 级联子代理 |
| 重复派发检测 | DA | 会话级同文本完全匹配警告；记录时机 = 实际启动（工具集报错/排队中止的未启动任务不占坑） |
| 权限继承 | Claude Code | 子代理走同一 executor→permissions 管线 |
| 并行执行 | leow3bot 自身 | `subagent` 设 concurrencySafe，复用 executor 批次 |

明确不采纳：DA 的 L0/L1/L2 预摄取（见 §1.4 分叉说明）、worktree 隔离（CC）、fork/上下文继承、后台运行 + 通知注入、声明式工作流拓扑、引擎级审计、resume 子代理——后五项为 v2 候选（§10）。

---

## 1. 理论基础：上下文经济学

### 1.1 核心矛盾

问题端：几千份文件的完整、精确、详细、全面分析。模型端：上下文窗口有限。理想上下文（模型想要的一切）的构成：

| 成分 | 量级（5000 文件场景） | 本质 |
|---|---|---|
| ① 系统提示词 + 任务目标 | ~2K token | 小而恒定 |
| ② 文件清单（路径/类型/大小） | ~25 万 token | 大而**可切分** |
| ③ 每个文件的原始内容 | 数千万 token | 巨大且**一次性** |
| ④ 每个文件的中间结论 | 100-250 万 token | ③ 的蒸馏，仍巨大 |
| ⑤ 跨文件综合所需材料 | 1-5 万 token | 小，真正的决策素材 |
| ⑥ 过程脚手架（工具调用流水账） | 随时间累积 | 用过即死 |

leow3bot 现有的全部上下文补丁（strip thinking、驱逐图片、压缩旧工具结果）都是在杀 ⑥；真正的难题在 ②③④。

### 1.2 生命周期分类法

对任何想进入上下文的信息 X，问的不是"要不要"，而是"什么时候被谁需要、需要到什么保真度"：

| 类别 | 判定 | 处置规则 |
|---|---|---|
| **常驻** | 整个会话反复需要 | 留主窗口，为永久占用辩护 |
| **分片可见** | 大，但每片只有一个消费者 | 只送进消费者的窗口 |
| **一次性** | 产生结论的瞬间需要，之后永不需要 | **在哪个窗口出生就在哪个窗口死** |
| **存档可寻址** | 太大进不了任何窗口，偶发需要 | 全文住磁盘，上下文只放索引 |
| **回流摘要** | 唯一被允许向上穿越窗口边界的东西 | 严格限量 |

主上下文的最终形态：**常驻 + 索引 + 回流摘要**（控制面）；一切数据面流量发生在子代理窗口和磁盘上。

### 1.3 判定流程

```
对每项工作 W：
Q1 产出 W 的结论，需要与大体积中间物反复交互？
    否 → 主对话直接做（不开子代理）
    是 ↓
Q2 中间物是一次性的（结论产生后不再需要）？
    否 → 跨阶段复用 → 磁盘存档 + 按需 read（也不开子代理）
    是 → 中间物必须在一次性窗口里生死 → subagent

对进入任何窗口的信息 X：
Q3 X 分片可见？→ 只送切片，不送全集
Q4 X 的全文有人会再要？→ 磁盘 + 索引行，不进窗口
```

subagent 不是默认答案——单步小结果主对话自己做更省；跨阶段累积的大中间物走磁盘笔记。**subagent 只在"迭代式加工一次性大中间物"时赢。**

### 1.4 subagent 的本质定义

> **subagent = 一次性内容的死亡窗口。** 它存在的全部意义，是让"必须被某个 LLM 看见才能变成结论、但看完就该死"的信息，在一个不污染主窗口的地方出生和蒸发。自主性只是实现手段。

与 DA 的分叉点：DA 选**预摄取**（先建 L0/L1/L2，为复用付费，平台思维）；leow3bot 选**按需加工**（层级在分析中自然涌现：原始文件 → 磁盘上的逐文件档案 → 上下文里的索引行，为轻付费，一次性任务思维）。同一语料被反复查询时 DA 对；一次性深分析时我们对。**禁止未来手痒去抄 L0/L1/L2。**

---

## 2. 判据：变换铁律与工具边界

### 2.1 变换分类（读取侧工具的铁律）

| 变换类型 | 例子 | 损失 | 允许？ |
|---|---|---|---|
| **零变换** | `view` 返回原图 base64 | 无——感知与推理同头 | ✅ 正统 |
| **无损变换** | `read` 读文本、逐字转录 | 对目标维度无损 | ✅ 允许 |
| **有损变换** | caption / 图像摘要 / 预处理描述 | **有偏损失**——中间模型替你决定什么重要 | ❌ 禁止 |

> **中间层只允许做枚举和转录，不允许做概括。** 有损变换只允许作为临时的、有回路的降级（如批次降采样——单张重看可回全分辨率），不允许作为永久的、不可回溯的压缩。

推论：看图的模型必须是能看图的强模型（子代理模型经 `/subagent` 显式配置，不自动降档）；永远不用视觉做搜索，视觉只做验证。

### 2.2 工具 vs skill+bash 的判据

| 能力归属判据 | 例子 | 归宿 |
|---|---|---|
| 需要**非文本 IO 通道**（往对话塞 image 块）、权限钩子、结构化返回、盲写守卫状态 | view / read / edit | 核心工具（少而稳） |
| 只是"知道怎么做 + 跑命令拿文本"（输出与 `ls` 无管道区别） | PDF/docx 抽取 | **skill（领域知识，多而轻）+ bash（执行）** |

三层分工：**tool = 管道原语 · skill = 领域知识 · bash = 通用执行器**。二进制格式抽取不做工具（否决过 extract 提案——那是把知识层下沉到管道层，方向反了）。

### 2.3 协议层定位

subagent 在协议上就是普通 tool_use（无 "AgentUse" 字段），Agent Loop 对它无感知；agent-ness 全部藏在工具的 execute() 里。嵌套控制是工具过滤策略而非协议约束；模型分辨不出真子代理与 mock（测试基础）。runTurn 参数化重构是因为现有循环状态是模块级全局单例（历史问题），不是协议要求。

### 2.4 模型决策面（设计者为模型写规则）

模型看不见成本结构，决策 = 对四层文本的模式匹配：

1. **工具 schema 描述**——要不要委派（一级决策），规则集 + 反例
2. **Agent 菜单**（descriptions 常驻 system prompt）——委派给谁（二级决策）
3. **系统提示词路由规则**——总体态度
4. **运行时反馈**——事后纠偏，报错文案即训练

三个要防的失败模式：过度委派、上下文错配（子代理不知道主对话聊了什么）、委派后重复劳动。

---

## 3. 命名规范

- **工具名 `subagent`**（不用 task）：名字即路由信号（CC 同理叫 Agent），且避免与未来 todo 类工具撞名
- **agent 名**：任务形状的动词/角色名词（explore、analyst），不玩梗不编码；与工具名不撞车；小写、ascii、1-2 词；有生态先例跟随先例（explore/general 对齐 CC/DA）
- **名字 + description 双职责**：名字做快速匹配，description 做细粒度消歧（中文展开，英文不译）
- agent_type 参数值是模型亲手写的字面量——语义名自带正确性偏置

---

## 4. 用户可见设计

### 4.1 `subagent` 工具 schema

```
subagent: {
  description: '把广度型调查委派给子代理在独立上下文中执行，只返回侦察报告。
    推荐节奏：陌生或大范围的任务，先一轮并行派出多个 subagent（按目录/角度
    分工）测绘全局概览，拿到候选位置清单后，由你亲自精读关键处校对细节——
    委派广度，亲为深度。适用：跨多文件搜索/定位/梳理、大目录探查画像、会
    产生大量搜索读取输出的调查。不适用：单文件单点查询（直接 read/grep）、
    需要当前对话背景的任务、需要修改文件的任务、精细的逐行阅读校对（自己做）。
    子代理看不到我们的对话历史、无法向你或用户提问——prompt 必须自包含
    （目标、范围、必要背景、期望输出格式）。已委派的搜索不要自己做，等结果。',
  concurrencySafe: true,   // 相邻多个 subagent 调用 → executor 批次 Promise.all 并行
  input_schema: {
    type: 'object',
    properties: {
      prompt:       { type: 'string', description: '委派任务书，由你撰写——子代理只能看到这条消息，看不到我们的对话。必须自包含：任务目标；范围；必要背景（把本对话相关的用户要求/已知结论/约束提炼进来）；期望输出格式' },
      agent_type:   { type: 'string', description: '子代理类型（默认 explore），可用类型见系统提示' },
      description:  { type: 'string', description: '一句话任务摘要（UI 显示）' },
    },
    required: ['prompt'],
  },
}
```

### 4.2 Agent 定义格式

与 skills 同构，加载器克隆 `skills.ts`：

```markdown
---
name: explore
description: （候选稿讨论中，见 §4.5）
tools: [read, view, bash, skill, web_search, web_fetch]
maxTurns: 25
---
（正文 = 子代理的 system prompt）
```

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `name` | ✅ | — | 唯一标识，遵循 §3 命名规范 |
| `description` | ✅ | — | 路由信号：动词开头 + 触发场景 + 反例，≤2 行 |
| `tools` | — | 全量 − subagent − ask | 工具白名单，只收窄不扩展 |
| `model` | — | 继承主对话 | 模型 id（仅自定义 agent 文件生效；v1 内置 explore 不设） |
| `maxTurns` | — | 25（上限 50） | 轮次上限 |
| `reportMarker` | — | 无 | 报告结构契约（如 `## 概览`）：done 的最终输出须含此标记，缺失按未完成错误返回——防"进度旁白碰巧结束回合"伪装报告（实测事故固化）；内置 explore 已设 |

扫描目录（后者覆盖前者同名，项目级 > 用户级 > 内置）：
1. `~/.claude/agents/`（CC 生态，白嫖现成定义）
2. `~/.leow3bot/agents/`
3. `./.claude/agents/`

### 4.3 模型配置：默认继承，`/subagent` 命令显式选择

- **默认 = 主模型**。子代理与主对话同模型，行为可预期、零配置。
- **显式配置 = `/subagent` 命令**：交互式选择器（仿 `/model`，列出端点 `/v1/models` + 「跟随主模型」默认项），选择写入 config 的 `subagentModel` 持久化（applyRuntimeConfig 扩展），下次启动保持。
- 解析顺序：agent 文件 frontmatter `model`（自定义文件可写）> `subagentModel`（/subagent 命令）> 继承主模型。
- v1 从简：不做模型别名、不做自动探测、不给工具级 per-call 覆盖（模型不该替用户做成本决策）。`/subagent` 运行中切换不影响已启动的子代理（model 启动时解析）。
- 注册进 COMMANDS；Onboarding 不涉及。

### 4.4 内置：v1 仅 explore 一个

| name | 工具集 | maxTurns | 职责 |
|---|---|---|---|
| `explore` | read/view/bash(只读闸)/skill/web_* | 25 | 只读侦察：跨库搜索、定位实现、梳理结构、大目录探查 |

- 默认 `agent_type` = explore（唯一内置，天然默认）
- **general 取消**：单代理形态下无需第二个通用内置——需要全量工具的通用委派，用户一行 frontmatter 自定义即可
- **analyst 不内置**：批量文档分析（§6）需要写能力，v1 经自定义 agent 文件实现；仓库附 `analyst.md` / `reviewer.md` / `researcher.md` 三个示例文件（不自动加载、零菜单成本），analyst 是否升内置看 v1 使用体感（v2 候选）
- 内置数量原则不变：由「工具集差异」决定——v1 只有 explore 拥有独特工具集（只读闸）

### 4.5 explore 完整定义（定稿）

```markdown
---
name: explore
description: 只读搜索代理，做广度扇出搜索：扫描大量文件、定位代码与文档、收集摘录。适合：单个事实需跨多处查找、先摸清陌生目录/大范围结构再动手、大目录混合语料（图片/PDF/word）分布画像。只定位，不审查；委派后等结果，不要自己再搜。
tools: [read, view, bash, skill, web_search, web_fetch]
maxTurns: 25
---
你是 leow3bot 的只读侦察子代理（侦察兵），为主对话测绘领域地图：全局概览、分布、候选位置。主对话将根据你的报告亲自精读关键处——你的职责是让精读不迷路，不是替它下结论。

## 铁律
- 只读：不得创建、修改、删除任何文件。bash 中禁止重定向写入（>、>>、tee）、
  touch/rm/mv/cp/mkdir/sed -i 等写操作——你只搜索和阅读
- 诚实标注：没读过就是没读过——grep/文件名命中只能报告为「⚑仅命中未读」，
  禁止描述未读文件的内容、禁止根据文件名或 import 推断内容；
  标「✓已读确认」的必须真的 read 过
- 自主完成：你无法向用户提问。信息不足就换角度扩大搜索，仍不足就在报告中
  如实说明缺口，不要编造
- 报告用中文（代码、命令、专有名词保留原文）

## 搜索方法
- 多角度关键词：中英文、驼峰/下划线、缩写/全称都试
- 先用 bash 的 grep -rn / find / ls 定位，再 read 关键文件确认
- 二进制格式（word/pdf 等）用 skill 工具获取抽取方法，再经 bash 执行
- 顺线索走：import → 定义处；调用处 → 被调用者
- 广度优先：预算优先花在覆盖更多位置上；判断相关性读开头几十行即可，
  读深留给主对话的精读
- 收窄输出：grep 加 -l/-c/head，别整文件 cat——大输出对你自己的上下文也是负担
- 信息充分即收队：关键问题已有答案、继续搜不再产生新信息时停止

## 报告格式（你的唯一交付物，主对话只能看到它）
## 概览
（范围多大、分成几块、各块是什么——几行勾勒地图）
## 候选位置
- 路径:行号 — 相关性一句话 〔✓已读确认｜⚑仅命中未读〕
（问题简单到能直接回答时，用「答案」一节代替本节，同样标注证据等级）
## 覆盖与缺口
- 搜了哪些位置/关键词；哪些没查到、不确定、超出范围

目标 500-1000 字，硬上限 4000 字符。报告必须自包含——主对话看不到你的任何中间过程。
```

**description（定稿，平实风）**：`只读搜索代理，做广度扇出搜索：扫描大量文件、定位代码与文档、收集摘录。适合：单个事实需跨多处查找、先摸清陌生目录/大范围结构再动手、大目录混合语料（图片/PDF/word）分布画像。只定位，不审查；委派后等结果，不要自己再搜。`

**文风基准（三家 description 原文，防再犯"刻意"病）**：

- CC Explore：`Read-only search agent for broad fan-out searches — sweeps many files, locates code, and gathers excerpts. Use when a single-fact lookup would mean grepping across many locations; it locates code; it doesn't review or audit it. Once you've delegated a search, don't also run it yourself — wait for the result.`
- Codex spawn_agent（二进制提取）：`Spawn a sub-agent for a well-scoped task.` + 四节规则手册（委派 vs 亲为 / 子任务设计 / 委派后 / 并行模式），核心句 `Only call this tool for a concrete, bounded subtask that can run independently alongside useful local work; otherwise continue locally.`；另注意其**默认禁止主动 spawn** 立场（除非用户/AGENTS.md 明确要求，"深度/彻底/调研"不算许可）
- DA 全部角色一句式：explore = `Search-oriented agent for finding relevant documents and information in the knowledge base. Read-only.`

归纳三条风格规则：① agent description = 身份 + 能力 + 至多一条触发条件，无隐喻、无人称叙事；② 编排/节奏/并行规则一律放工具 description 或 system prompt，agent 行不背编排；③ 边界声明用五个词（"定位不校对"✓；"'在哪里'它来找'是什么'你确认"✗）。

**补充对照（Codex V2，二进制提取）与派生原则**：Codex 无类型注册表——`task_name` 仅寻址（"lowercase letters, digits, underscores"），description 路由层不存在；其自包含问题用 `fork_turns` 上下文继承消解（"fork_turns='none'... may cause the agent to lack the context it needs" 警告证实任务书不足即失败）。派生：**description 风格由类型数决定**——单类型无「选谁」决策，纯中性（v1 现状：explore = 纯能力陈述）；多类型时恢复路由线索（CC 式）。任务书采用 CC 路线：主代理撰写、自包含（prompt 参数描述载明可见性约束 + 背景蒸馏职责 + 输出契约），runner 不做模板机制；fork_turns 式继承为 v2 首选候选（消解 GLM 任务书写不稳的风险敞口）。

工作流契约：**委派广度，亲为深度**——阶段 1 并行侦察拿地图，阶段 2 主对话亲自精读校对；encode 位置 = 工具 description（推荐节奏段）+ system prompt 菜单行，agent description 不承载编排。子代理只承担容许损失的索引层，最终阅读在主上下文全保真进行（反"摘要丢细节"的结构性答案）。

runner 追加环境块（cwd / git root / 平台 / 日期）+ skill 清单 + web 工具指引（与主对话 buildSystem 同构）。

---

## 5. 运行时架构

### 5.1 核心重构：runTurn 参数化

```
runAgentLoop(opts: {
  messages, system, toolSchemas, model?, signal,
  maxTurns, sink,            // UI 事件出口（主对话=store，子代理=静默）
  autosave?: boolean,        // 仅主对话 true
  onAssistantMsg?,           // 主对话挂 maybeUpdateTitle
})
```

主对话路径 = 现有 runTurn 变薄包装；子代理路径 = 新 messages + agent system + 过滤后 schemas + 静默 sink。现有轮内机制（strip/evict/重试降级/看门狗）操作传入的 messages，全部自然继承。`callLLMStream` 增加 model 覆盖参数。

### 5.2 子代理执行流程

```
subagent(prompt, agent_type) 被 executor 调用
  → AGENTS_REGISTRY 查定义（未知类型 → error + 可用列表）
  → 护栏：prompt <10 字符报错 / 并发闸 / 重复派发检测
  → 组装：system = agent 正文 + skill 清单 + web 指引 + 环境块
          messages = [{ role:'user', content: prompt }]
          toolSchemas = 白名单过滤（subagent/ask 强制剔除）+ per-agent 包装
  → runAgentLoop（挂父 AbortController 链）
  → 最终 text > 4000 字符 → persistToolOutput 落盘截断
  → 返回 { type:'task', output: 摘要行, report, turns, toolCalls, model, persistPath? }
```

### 5.3 per-agent 工具包装（一份机制两处用）

runner 组装工具集时按定义包装个别工具：

**① explore 的 bash 只读闸（方案 B，已实现）**：判定规则——**显式白名单且不含 edit/write 的代理视为只读意图，其 bash 加闸**（缺省全量不算只读；有写工具的代理不拦）：

```typescript
const WRITE_SHAPE = /(^|[\s;&|(])(>>?)\s*(?!\/dev\/null)|(^|[\s;&|(])(touch|rm|rmdir|mv|cp|mkdir|tee|truncate|shred|ln|chmod|chown|install|dd)\s|sed\s+[^;|]*-i|find\s+[^;|]*(-delete|-exec)/;
// 命中 → error：「⛔ explore 是只读侦察代理，禁止任何写操作（检测到重定向/写命令）。
// 查含 > < 的内容请用引号包裹参数或 grep -F；确需写文件的任务请交给主对话」
// 漏网（python -c "open(...)" 类）由 prompt 铁律 + 全局 deny 黑名单兜底；AST 静态保证是 v2
```

**② analyst 的工作区限定 write（DA 重定向模式，v2）**：write 的路径解析进 `~/.leow3bot/analysis/<会话hash>/`——写入域有界 = 给写能力又不给乱碰仓库的权限。v1 的 analyst 走示例文件（prompt 约束只写 `./analysis/`），机制化重定向随 analyst 升内置时实现。

### 5.4 工具集收窄规则

1. 强制移除：`subagent`（v1 不嵌套）、`ask`（子代理不能向用户提问）
2. frontmatter `tools` 白名单过滤；未命中的工具名在启动时报错（防零工具空转）
3. 白名单只收窄不扩展

### 5.5 并行执行（一轮多开）

**能。机制零新增，全部复用现有 executor：**

- LLM 单轮可发出多个 subagent tool_use（并行与否由模型决定，schema 描述引导"一轮可并行发出独立子任务"）
- `partitionToolCalls` 把**相邻的** concurrencySafe 调用合并为一个批次 → `Promise.all` 并发执行、保序回收 → 结果合并为一条 user 消息（Anthropic 契约不变）
- 相邻性注意：两个 subagent 调用之间若夹了串行类工具（bash/edit/write），会被拆成串行段——现有行为，schema 引导模型把并行调用排在一起
- 并发上限 3：超额调用**自动排队**（信号量）——前台阻塞语境下排队严格优于拒绝：拒绝要多付一次 LLM 往返重发，排队零浪费（原 DA 式拒绝设计经实测废弃）
- 取消：ESC 中止整个批次（父 signal 链到批内每个子代理）
- UI：批次内各 task_start 行先统一出现，⎿ 结果行在整批完成后按序回显（最慢者决定整批时长）

### 5.6 UI：静默 scrollback + 动态区状态面板 + 标准工具渲染

主 UI 里 subagent 就是一对 tool_start/tool_result，scrollback 零过程污染：

```
⏺ subagent(explore): 定位 auth 中间件实现
  ⎿ 完成（12 轮/4 文件）：实现于 src/middleware/auth.ts:45，JWT 校验在 :120
```

运行期间的可见性走 CC 式**动态区状态面板**（输入框上方每行一个运行中子代理，实时显示 agent 名 · 任务摘要 · 轮数 · 最近工具活动 · 耗时；结束即移除，留档的只有 ⎿ 结果行）：

```
  ⠋ explore · 定位 auth 实现 · 第 12 轮 · ⏺ bash: grep -rn auth src/ · 45s
```

机制：runner 的 `makeSubagentSink` 只把 tool_start（activity 行）与 usage（轮数）转发到 store.subagents 动态切片；phase/text/thinking 仍静默（不抢主循环 phase、不刷流式输出）。面板行数天然有界（并发上限 3）。结果对象 `output` 字段供 ⎿ 行摘要（防 JSON.stringify 泄露全文）。

### 5.7 取消链

主对话 ESC → abortRef → 批次中止 → 父 signal 链到子代理 AbortController → callLLMStream 中止 → 返回 `{ status:'interrupted' }` 摘要（注明被中断 + 已完成 N 轮，不装正常完成）。

### 5.8 权限语义

- deny 黑名单 / remembered allows：照常生效
- **confirm 规则：子代理内自动拒绝**（并发语境争抢唯一 askResolver + 阻塞主对话是最差体验），错误信息注明「可在主对话直接执行以触发确认」

### 5.9 共享状态

- `READ_KNOWN_FILES`：共享（子代理读过 = 内容已知，且批次期间主循环挂起无并发突变）
- autosave / maybeUpdateTitle / StatusBar usage：仅主对话
- `modelLimits`：共享（按模型 key 天然正确）

---

## 6. 语料库场景（主场景管线）

几千文件（图片/pdf/word 混合）的完整、精确、详细、全面分析。**v1 内置仅 explore（只读）**：阶段 2 的批量档案分析需写能力，v1 经自定义 agent 文件实现（附 analyst.md 示例），analyst 升内置为 v2 候选：

```
阶段 0  探查（主对话，便宜）     bash find/file/stat → manifest（路径/类型/大小）
阶段 1  分片（主对话，纯推理）   按类型/目录分组；图片片小（10-20 张/片，保真度旋钮
                                ——防子代理窗口内注意力稀释），文本片可大（20-50）
                                关键：每个文件归属且只归属一片（覆盖度矩阵）
阶段 2  并行分析（analyst × N）  逐文件 view/read/skill+bash 抽取 → 结构化档案
                                追加写入工作区结果文件；片摘要回流（计数+亮点+路径）
阶段 3  汇总（主对话）           读片摘要，按需 read 档案抽查，综合成报告
阶段 4  全局异常扫描（v2）       跑在档案文本上，不跑在图片上（见 §6.3）
```

### 6.1 反"摘要损失"设计（核心）

摘要损失是有偏的：丢掉的恰是"没被意识到重要"的东西。对策按损失边界逐个封：

- **记录/汇报边界 → 结构化档案替代自由摘要**：谁决定什么重要——自由摘要由疲惫的子代理决定（随机损失），schema 化档案由任务定义决定（受控损失）。凡能枚举的不做概括：

```yaml
file: IMG_2037.jpg
type: 照片
transcript: "..."            # 图中全部可见文字逐字转录 ← 文字细节 100% 存活
objects: [人物×3, 桌子, 蛋糕]  # 清点所有对象，不概括为"聚会照片"
unusual: "背景窗上有一个人影"   # 必填，没有则写"无"
flag: normal | suspicious
```

档案 schema 由派发时的主对话定义，作为 prompt 的一部分传入。

- **感知边界 → 四个压低手段**：schema 强制注意力（枚举/转录字段）；看图用旗舰档（模型路由 = 注意力分配工具，不只是省钱）；片小 + 即看即释（防窗口内稀释）；可疑即二次复核（flag≠normal 由另一代理重看）。

### 6.2 三层保真度模型

| 层 | 住哪 | 内容 | 激活 |
|---|---|---|---|
| 🔥 热 | 主上下文 | 每文件一行索引 | 常驻 |
| 🌡 温 | 磁盘 | 完整档案 | read 一步取回 |
| ❄ 冷 | 磁盘 | 原始文件 | view/重抽取一步回到全保真 |

"subagent 看完就结束"不成立——死的只是子代理窗口，档案和原文件都活着。契约：最终报告每个断言必须引用温/冷层（file + 字段），不引用档案的结论不许写。

### 6.3 全局异常检测原则

"特别"是比较出来的（跨片异常单片看不见）→ 第二遍扫描跑在**档案（文本）**上：确定性预筛（bash grep/sort 统计字段分布，离群机械浮出，零 LLM）→ 档案级 LLM 扫描（文本便宜一个量级）→ 仅候选 view 原图复核。**永远不用视觉做搜索，视觉只做验证。**

### 6.4 断点与预算

- 片结果落盘 = 天然 checkpoint，重跑先查工作区复用已完成片
- 并发 3（TUI 上限）；几千文件 ≈ 数十片 ≈ 串行分批派发
- 图片海采样策略写在 analyst prompt：按尺寸/命名/目录聚类，同类抽样 + 异类全查（逐张是预算决策，明码标价）

---

## 7. 成本护栏

| 护栏 | 值 | 位置 |
|---|---|---|
| 子代理轮次上限 | 默认 25（自定义 agent 的 frontmatter 可调，硬上限 50） | runner |
| 并发子代理上限 | 3；超额自动排队（信号量，非拒绝） | runner 信号量 |
| 报告长度上限 | 4000 字符（超出落盘 + 截断提示） | runner |
| 重复派发检测 | 同会话 ≥70% 任务文本重叠 → 警告拒绝 | runner |
| 菜单 token 预算 | > 2K token 启动警告 | loader |

---

## 8. 模块改动清单

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/subagents/loader.ts` | 新增 | AGENTS_REGISTRY / loadAgents / getAgentListing / 内置三件套定义 |
| `src/subagents/runner.ts` | 新增 | runSubagent：护栏 + 组装（含 per-agent 工具包装）+ runAgentLoop + 落盘 |
| `src/agent.ts` | 重构 | runTurn 抽出参数化 runAgentLoop；主路径变薄包装 |
| `src/tools.ts` | 修改 | 注册 subagent 工具（惰性 import 防循环依赖） |
| `src/llm.ts` | 修改 | callLLMStream 接受 model 覆盖 |
| `src/config.ts` | 修改 | getAgentDirs / subagentModel 配置（applyRuntimeConfig 扩展）/ 护栏常量 / ANALYSIS_WORKSPACE |
| `src/commands.ts` | 修改 | 注册 `/subagent` 命令（COMMANDS + 进选择器） |
| `src/components/SubagentPicker.tsx` | 新增 | 仿 ModelPicker：模型列表 + 「跟随主模型」选项 |
| `src/main.tsx` | 微调 | loadAgents + 菜单计数进 meta |
| `src/components/*` | 微调 | subagent 结果摘要渲染确认；StatusBar nTools +1 |
| `docs/agents-examples/` | 新增 | analyst.md / reviewer.md / researcher.md 示例（不自动加载） |

核心工具集定稿十件套：bash / read / view / edit / write / skill / ask / web_search / web_fetch / subagent（唯一新增）。

---

## 9. 边界情况

- 会话恢复：subagent 的 tool_use/tool_result 是普通工具调用，rebuildCommitted 天然重建
- 子代理空报告 / maxTurns 耗尽：返回「未完成」+ 部分输出注明（残次品不装完整结论）
- **报告状态内带**：report 正文首行标注 `[子代理 x · 完成（N 轮/M 工具）/被中断/达上限]`——UI 的 output 行不进上下文，状态必须内带才能到达主模型
- **进度旁白伪装报告**（实测：GLM 长重复任务中途输出"继续第 8 页："后停止，旁白被当报告）：reportMarker 契约拦截为未完成错误 + 子代理 prompt 铁律「进度旁白不得结束回合」
- **图片 payload 400 毒化**（实测：智谱 code 1210「图片输入格式/解析错误」——坏图进入历史后每轮请求都 400，子代理整死）：`isImagePayloadError` 判定 → 归入 retryable → 接入既有降级链（重试 2 次 → evictOldImages 释放坏图 → 再试）
- 子代理内部错误：重试降级链耗尽 → 错误摘要返回，主模型自行决定重派或绕开
- 嵌套 subagent / ask：工具集已剔除；模型强造 → 「未知工具」自然拦截
- 模型中途切换（/model）：不影响运行中子代理（model 启动时解析）
- prompt 为空/过短（<10 字符）：报错引导补全
- 用户自定义覆盖内置（同名）：项目级 > 用户级 > 内置，与 skills 同语义
- 一轮并行超额（>3）：超额项自动排队，槽位释放即启动（排队中被 ESC 也能停——controller 先建，启动即检中止）
- 分析工作区：`~/.leow3bot/analysis/<会话hash>/`，会话隔离，不清理（用户自查自删）

---

## 10. v2 候选池（按优先级）

1. bash AST 只读静态保证（bash-ast-parser 路线，DA 已验证）
2. analyst 升内置（批量文档分析代理，看 v1 自定义使用体感）
3. fork / 上下文继承（子代理带主对话最近 N 轮冷启动）
4. 子代理 resume（返回 agent id，可续）
5. 全局异常扫描阶段（§6 阶段 4，档案级交叉验证）
6. 运行中状态可视化扩展（/tasks 面板 + 嵌套子代理树；动态区状态面板已随 v1 落地）
7. 声明式多代理拓扑（pipeline/graph）
8. 后台子代理 + 完成通知注入
9. worktree 隔离（并行写文件）

---

## 11. 测试方案

- **单元**（test-agents.ts）：loader 解析（字段/缺 name 跳过/同名覆盖）、工具集过滤（subagent/ask 强制剔除、未知工具报错）、bash 只读闸正则（拦/放样本）、工作区路径重定向、重复派发检测、报告截断落盘、模型别名解析
- **集成**（test-app.tsx 扩展）：runAgentLoop 的 streamFn 参数化注入假流（tool_call → result → done 固定脚本），断言静默 sink 隔离与摘要回传
- **手测**：双 subagent 并行 + ESC 中断链 + /resume 历史重建 + 真实语料库目录小规模跑通

## 12. 交付切分

1. `agent.ts` 重构：runAgentLoop 参数化（纯重构，现有测试全绿为验收）
2. `subagents/loader.ts` + config 常量 + 菜单注入（无行为变化）
3. `subagents/runner.ts` + subagent 工具注册（最小闭环：general 单代理串行）
4. explore 内置 + bash 只读闸 + `/subagent` 命令与选择器 + 三个示例 agent 文件
5. 护栏（并发/重复检测/截断）+ 测试补全 + README
