# leow3bot 测试方案

从最小单元到端到端的四层测试体系 + 全量自动运行（本地 git hook 与远端 CI 双门）。
目标：**任何新特性或 bug 修复，在全量测试绿之前不算完成**——提交时快速拦截类型错误，
推送前本地全量验证，推送后 CI 在 node 20/22 双版本上复验。

```
npm test            # 全量：typecheck → vitest(unit+integration) → E2E
npm run test:unit   # 只跑 unit 层
npm run test:integration
npm run test:e2e    # mock LLM 服务器 + PTY 真进程
npm run test:watch  # 开发时 watch 模式
```

## 分层结构

| 层 | 位置 | 测什么 | 依赖形态 |
|---|---|---|---|
| **unit** | `tests/unit/` | 纯函数与模块逻辑：format/compaction/权限规则/命令解析/skill 加载/看门狗/store 拆行状态机/markdown 渲染/App 组件渲染/**五个 picker 交互**（Model/Skills/Subagent/Session/Onboarding——键盘注入驱动）/title 后台主题节流 | 无 IO 或全 mock（fetch/LLM SDK） |
| **integration** | `tests/integration/` | 真实文件系统与子进程：read/write/edit/bash/view 工具（盲覆盖守卫、分页、图片管线）、会话持久化 roundtrip、配置合并写回、LLM 流组装（mock SDK 驱动完整 SSE 解析）、子代理全生命周期 | tmpdir + `LEOW3BOT_HOME` 隔离 |
| **E2E** | `tests/e2e/` | 真实进程全链路：PTY 起真 `main.tsx`，mock LLM 服务器收发协议级请求，验证启动/命令/对话/工具循环/autosave/退出 | `script(1)` PTY + 本地 mock HTTP |

三层共用一套**隔离旋钮**（src 已内建）：

- `LEOW3BOT_HOME` — 重定向用户级 home（config/sessions/skills/permissions 落盘全在临时目录）
- `LEOW3BOT_API_BASE_URL` — LLM 端点指向本地 mock（优先级高于配置文件）
- `LEOW3BOT_PERMISSIONS_FILE` — 权限记忆文件重定向

## vitest 约定

- forks 池 = **每个测试文件独立进程**：src 的模块级单例（store 状态、agent messages、
  权限记忆、skill 注册表）天然互不污染；同文件内如需重置自行处理（见
  `tests/unit/store.test.ts` 的 `resetCommitted`）。
- 需要在 import src 前设置环境变量的测试用 `vi.hoisted`（hoisted 体在 import
  初始化前执行，**不能引用 node 模块**——路径用字符串拼接，见
  `tests/unit/permissions.test.ts`）。
- `vi.resetModules()` + 动态 import 可拿到全新的模块实例——用于测「import 时定格」
  的 config 加载语义（`tests/integration/config.test.ts`）。
- 描述块体在**收集期**执行（先于任何测试）：收集期读全局注册表要先在模块顶层
  初始化（见 `tests/integration/agents.test.ts` 顶部的 `loadAgents([])`）。
- vitest env 注入 `FORCE_COLOR=1` 与 `CI=false`（ink/chalk import 时缓存颜色支持；
  ink 在 CI 模式下动态区不写出，渲染断言会失效）。

## E2E 工作原理

```
run-e2e.ts ──启动──▶ mock-server.ts（node:http，Anthropic 兼容）
    │                     │ /v1/messages（SSE 流 + JSON 非流）
    │                     │ /v1/models、/v1/messages/count_tokens
    ├─script(1) 分配 PTY─▶ node tsx src/main.tsx（真实进程，全套隔离环境）
    │
    └─断言：UI 输出（strip-ansi 后子串匹配）+ 服务端记录的请求体（协议契约）
```

六个场景：启动渲染 / `/help` / 纯文本对话（thinking+text 流）/ **工具全循环**
（LLM 发 tool_use → 真实执行 bash → 服务端断言 tool_result 按契约回传 → 最终回复）/
autosave+后台主题生成 / `/q` 干净退出。

踩过的坑（写测试前值得读）：

1. **PTY 尺寸**：`script` 的 stdout 是管道时 PTY winsize 为 0，ink 动态区（提示符/
   状态栏）被压塌——命令里必须先 `stty rows 40 cols 120`。
2. **逐键输入**：真实终端逐字符到达；整串一次写入会被 ink 当成单个多字符 input
   事件，`key.return` 不触发——文本与 `\r` 分开写。
3. **UTF-8 chunk 劈裂**：`❯` 是 3 字节，跨 chunk 边界时 `toString('utf-8')` 产出
   U+FFFD 永远匹配不到——用 `StringDecoder` 缓冲不完整序列。
4. **ink 的 CI 模式**：环境带 `CI=true` 时 ink 只写 Static、动态区只存 `lastOutput`
   不输出（GitHub Actions runner 自带 CI=true，会被 `...process.env` 继承）——
   子进程 env 必须显式 `CI: 'false'`。

ink-testing-library 的假 stdin 也有两个坑（picker 组件测试 `tests/unit/*-picker.test.tsx`
的 `press()`/`settle()` 助手就是为它们存在的）：

5. **一次写入滞后**：假 stdin 的每次 `write` 只在**下一次** write 的 readable 事件
   里被消费——`press()` 在按键后跟一个空串 write 冲刷（空串解析为无按键事件的
   no-op，对各组件的分支判断无害）。
6. **帧可见 ≠ effect 重绑完成**：vitest 调度下 `lastFrame()` 已显示新状态，但
   `useInput`/`TextInput.onSubmit` 的 effect 可能还没用新闭包重绑——下一键会落进
   旧闭包（读到旧 state）。连续按键之间在帧等待之后必须再等一个 macrotask
   （`settle()` ≈ 50ms）。

## 自动化（目标：改完自动跑全量）

| 时机 | 机制 | 跑什么 |
|---|---|---|
| `git commit` | husky `pre-commit` | `npm run typecheck`（秒级快速门） |
| `git push` | husky `pre-push` | `npm test` 全量（跳过：`git push --no-verify`） |
| push / PR | `.github/workflows/ci.yml` | typecheck + vitest + E2E，node 20/22 矩阵 |

## 如何加测试

- 新的纯逻辑 → `tests/unit/`，同文件内组织 describe；需要隔离 home 的参照
  `vi.hoisted` 模式。
- 涉及真实 fs/子进程 → `tests/integration/`，tmpdir + `LEOW3BOT_HOME`。
- 涉及 LLM 交互 → mock：单测层 `vi.mock('@anthropic-ai/sdk')`（见
  `tests/integration/llm-stream.test.ts` 的合成 SSE 事件法）；跨进程层在
  `mock-server.ts` 的 `onStreamRequest` 里按请求体特征编排回复脚本。
- 新的用户可见行为 → 在 `tests/e2e/run-e2e.ts` 加场景（freshEnv 起隔离环境，
  `app.send()` 逐段输入，`app.waitFor()` 等输出）。

## 历史战果

本套测试在落地过程中抓到并修复的 src 真实 bug：

1. `config.ts` `updateHomeConfig` 用 `homedir()` 绕过 `LEOW3BOT_HOME` 隔离——
   测试写盘污染真实用户配置（`~/.leow3bot/config.json`）。
2. `llm.ts` 看门狗 `finally` 中 `await it.return()` 在底层流永悬时死锁——把已
   转换的挂起错误重新变成永久挂起，看门狗失效。
3. `compaction.ts` 幂等守卫找 `[已压缩]`（带闭括号）而写入的是 `[已压缩，…]`——
   守卫永不命中，二次压缩反复重切同一段内容。
