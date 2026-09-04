# dsh（DeepSeek Harness）二次开发可行性核查报告

> 核查日期：2026-09-04。核查对象：github.com/deepseek-ai/deepseek-harness（默认分支 `master`，TypeScript，创建于 2026-08-13，截至今日 pushed_at 2026-09-04、约 21.2 万 star，MIT 协议）。
> 所有引文均来自仓库 master 分支实抓文档（raw.githubusercontent.com），非凭印象。dsh 处于 **developer preview**，README 明言 "THERE WILL BE COMPATIBILITY-BREAKING CHANGES"。

## 0. dsh 是什么（30 秒版）

- "Everything is a Plugin"：模型适配器、工具注册表、会话日志、agent 循环本身全部是插件，底层框架是 **Cordis**（README："powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in *A Programming Paradigm for Spatiotemporal Composability*"，arxiv 2608.25512）。
- 启动形态：`npx @deepseek-ai/dsh web`（Web UI，127.0.0.1:3080）；另有 `headless`（一次性跑完打印答案）、`sdk`（JSON-RPC stdio 服务）、`sdk-minimal`、`acp` 五个 profile。profile = 有序插件 bundle 补丁层，任何一行插件配置可被自己的 `cordis.patch.yml` 覆盖/替换（docs/architecture.md）。
- 架构文档极其完备：`docs/subsystems/*`（40+ 篇）、生成的事件生产/消费矩阵（docs/event-producer-consumer.md）、工具执行流水线图（docs/tool-execution-pipeline.md）、持久化事件目录（docs/persistence-catalog.md）、7 章 Cordis 教程。

---

## 1. 动作拦截 —— 结论：**有，且很完整（绿）**

### 1.1 原生插件拦截点（waterfall 事件）

`docs/tool-execution-pipeline.md` 给出完整流水线：

> "The `tools/pre-execute` waterfall runs first, monotonic guards run next, and the `tools/execute` and `tools/post-execute` waterfalls follow; the three waterfalls may transform a call. Definition-owned `finalizeContent` and `tools/result` run afterward."

即每次工具调用有四个挂点：

| 挂点 | 时机 | 能做什么 |
|---|---|---|
| `tools/pre-execute` | 工具体执行前 | "hooks, permission, sandbox"；可 allow / **deny** / ask（触发 `ctx.approval` 审批） |
| `tools/execute` | 环绕工具体（around dispatch） | timeout、retry、metrics |
| `tools/post-execute` | 拿到结果后 | "accept, block, replace, add context"（可改写结果、追加上下文） |
| `tools/result` | 最终 | "synchronous notification — frozen authoritative outcome"（只读观察最终结果） |

入参和结果是完整的：会话日志事件 `tool/call` 记录 "`name` with the raw `arguments` JSON string **exactly as the model produced it** (unparsed)"，`tool/result` 记录 model-facing result + 错误 identity + 工具私有 meta（docs/subsystems/session.md）。文件写入另有专门事件 `fs/write-intent` / `fs/edit-intent`（waterfall）和 `fs/observed`（docs/event-producer-consumer.md），可精确追踪文件改动。

### 1.2 Claude Code 风格外部 hook（shell 命令 + stdin JSON）

官方插件 `@deepseek-ai/dsh-hooks-claude-code` 直接跑现有 Claude Code `hooks.json`：支持 `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` / `SubagentStart` / `SubagentStop` 七个事件；"a hook that exits with code 2 stops the prompt or tool call"、可 "attach context — return extra text that the model sees in the next request"（packages/hooks/hook-protocol/README.md）。已知限制：`updatedInput`（改写工具入参）"parsed but not honored"；`{"continue": false}` 无 run-level 硬停；payload 里 `transcript_path` 恒为空串。第三方生态里已有类似插件（truelove-dreamer/dsh-plugin-hooks）。

### 1.3 外部程序消费（事件流）——对本产品最关键

三条路，全部现成：

1. **SDK JSON-RPC（stdio）**：`dsh --profile sdk` 起 JSON-RPC 2.0 服务，server→client 通知 `session.event` 推送 "**every session in the runtime, unfiltered**"（packages/sdk/protocol/README.md）——工作台进程可以逐事件（含 tool/call、tool/result、user/message、assistant/message）实时收流。TS 客户端 `dsh-sdk-client` 有 `subscribe()` / `subscribeSessionTree(id)`；Python SDK 同构。
2. **Web API gateway**：session-controller 暴露 `@Remote({mode:'stream'}) follow(...)`——"a complete opening snapshot followed by gap-free durable event frames"（docs/subsystems/session.md），Web UI 自己就是这么渲染的。
3. **直接读盘**：JSONL 持久化配 `compression: 'none'` 时 "the log is newline-delimited text an external reader can consume directly"（packages/session/session-persistence-jsonl/README.md）。

**对账场景注意**：产品是"标记不拦截"，所以其实不需要阻塞式 hook——被动消费 `session.event` 流就够；`tools/pre-execute` 的 deny/ask 能力算免费赠品（未来想升级成拦截也有路）。

---

## 2. 上下文注入 —— 结论：**有，多层次（绿）**

- **进程内插件**：`agent.inject()` 是官方指定机制——architecture.md "Where new behavior goes" 表格："Add model-facing context → call `agent.inject()`; **it lands in the next admitted request**"。注入内容作为带类型 source 的 `user/message` 事件落日志（"a synthetic `agent.inject()` context (file-change notices, subdir AGENTS.md, skill content, cron notifications, …)"），可回放、可审计。注意：闲置注入不主动唤醒——"injected context waits in the inbox until another message does"。
- **Steering（会中转向）**：`Agent.steer()`——"an idle target starts a turn, while a running target claims it at the nearest step boundary"（docs/subsystems/subagent.md）；模型侧还有 `send_message` 工具可 steer 相邻 agent。
- **改写将进入模型的内容**：`agent/pre-step` waterfall "Listeners may rewrite the claimed messages or reject them outright"（docs/architecture.md）。
- **外部进程注入**：SDK 的 `session/prompt`（入队回执）、gateway 的 `@Remote('prompt')`（带 source metadata 和 delivery mode）；hook 的 `additionalContext` 也算一条轻量通道。

**回滚重做时"把人的指正喂回去"**：fork 出新会话后，用 remote `prompt` / SDK `session/prompt` 把指正作为首条消息发入即可，零插件开发；要更精细（作为 injected context 而非用户消息）则写一个几十行的原生插件调 `agent.inject()`。

---

## 3. 过程记录 —— 结论：**这是 dsh 的核心设计，远超需求（绿）**

- 会话是**事件溯源的 append-only 日志**："A `Session` is an **append-only log** of typed `SessionEvent`s — the single source of truth… The LLM message history is *derived* from the log, never stored separately"（docs/subsystems/session.md）。铁律："**Model-visible means logged.** Anything that reaches a model request must be reconstructable from the log, and a runtime invariant asserts it"（docs/architecture.md）。
- **天然分层结构**，直接映射"粗粒度展示/细粒度展开"：`turn/start` → `step/start` →（`user/message`、`assistant/message` 含精确计时流+token usage、`tool/call` 含模型原始参数、`tool/result`）→ `step/end` → `turn/end`；每个事件带单调 `seq` 和 epoch ms `time`。turn=一轮人机交互，step=一次模型请求+其工具调用。"第 N 步做了什么"可以精确重建，连失败/被打断的模型尝试都留档（`assistant/attempt`）。
- **落盘**：`dsh-session-persistence-jsonl`（唯一第一方后端）按会话一目录，`session.v2.jsonl(.zstd)`，一事件一行；`compression: 'none'` 时是纯文本 JSONL。配 `dsh-session-checkpoint-policy` 有崩溃级持久化保证。日志格式有版本化迁移（v0→v1→v2）。
- 加分项：Web UI 已有 **Trajectory 视图**（packages/client/ui-trajectory）——"turn-aware event ledger with selectable User, Assistant, Tool, and nested Subtool records, plus an interactive timing overview"，就是一个现成的分层时间线回放，可直接参考甚至复用其数据投影；`/export` 一键导出全会话树 ZIP（含子会话与附件，packages/session-query/session-log-export）；`session-query-sqlite` 支持检索。
- **对账素材充足**："人类说了什么"= `user/message`（source 区分真人 prompt / 注入 / steering）；"agent 实际做了什么" = `tool/call`+`tool/result`+`fs/observed`。记录员逐事件比对即可。

---

## 4. 回滚 / 分支 —— 结论：**会话分叉是一等公民；工作区文件不回滚，需 git 配合（黄偏绿）**

- **会话 fork 原生支持**：`SessionStore.fork(source, boundary?, childSessionId?)`——"selects source events through the inclusive `SessionSeq` boundary…then creates a live child session with deep-cloned seed events, `parentSession`, `isSeeded: true`, the exact `inheritedEventCount`"；"An explicit `boundary` lets callers fork from **any stable between-turn position**, including a previous `turn/end`…even if the source has newer events or an open current turn"（docs/subsystems/session.md §Live-session fork API）。且通过 gateway 远程可调：`@Remote('fork')` — "Fork one cold-readable completed-turn prefix into a new Session"。血缘持久化（`parentSession`、`session/end-seed {inherited:true}` 标记），**原分支完整留存**——正好满足"原分支暂存留作记录和 redo 依据"，不用自己造。
- **粒度限制**：fork 边界必须落在 **turn 之间**（"requires the selected prefix to end outside an open turn"，拒绝而非静默截断）。产品的"指着某一步回滚"若指 turn 级完全没问题；若要 step 级（一个 turn 内的某次工具调用之后）则不被官方 fork API 支持，需用底层 `ctx.sessions.create(id, {seed})` 自己裁剪事件前缀（风险：破坏 turn 完整性不变式，不建议 43 小时内碰）。
- **最大缺口：没有工作区快照/回滚**。fork 只分叉对话日志，agent 已写的文件、已跑的命令不会撤销；全仓未见 checkpoint-workspace / rewind-files 类机制（子 agent 里倒有 e2b 远程沙箱 provider，但那是隔离不是快照）。
- **git 模拟方案可行性：高**。做法：工作台在每个 `turn/end`（从事件流里听）自动 `git commit` 打点（或用 worktree 一分支一 fork）；回滚 = ① remote `fork(source, boundary)` 得新会话 ② `git branch` + checkout 到对应打点 ③ 把指正 `prompt` 进新会话。dsh 侧的 `fs/observed`/`tool/call` 日志可用来提示"该 turn 改了哪些文件"。风险点仅在非 git 可控副作用（装包、外部 API 调用），产品上标注"不可回滚动作"即可——而这恰好也是对账时间线能标出来的。

---

## 5. 附加核查项

### 5.1 多实例 / 子 agent 编排 —— 强

- Subagent 是独立能力缝（seam），**多 provider 并存**按名注册（`ctx.subagents`）：`spawn-in-process`（新子 agent）、`fork-in-process`（分叉父会话上下文）、`dsh-sdk`（独立子运行时进程）、`acp`、**`codex`、`claude-code`**（可把整个 Codex/Claude Code 当子 agent 用）。
- **可持续对话的子 agent** + 全局控制工具 `send_message` / `interrupt_agent` / `list_agents`（packages/subagent/tool-subagent-control）；子 agent 目录持久化，可冷恢复再 steer。
- 实验性 **Agent Teams**（`ctx.agentTeams`）："a durable roster, task board, and mailbox layered over continuable subagents"（docs/architecture.md）——"单人指挥多个 agent"的产品形态在 dsh 里有直接对应物。
- 外部编排：SDK 通知含 `subagent.started` / `subagent.finished`，`subscribeSessionTree` 可按会话树过滤；也可以简单粗暴起 N 个 `DeepSeekHarness` 实例（每实例一子进程）。

### 5.2 插件开发门槛 —— 低起步、陡深入

- 语言 TypeScript；最小插件 = 导出 `name` + `apply(ctx)` 的模块，一个 yaml patch 行挂载，教程实测路径完整（docs/user/develop/basic/index.md、7 章 cordis-tutorial）。注册皆可逆（`ctx.effect()`），支持热重载（web profile 默认 live patch reload）。
- 事件系统五种 dispatch 模式（emit/waterfall/parallel/serial/bail）需要学习，但文档给了生产者/消费者矩阵和逐子系统参考；官方示例插件极多（仓库本身 200+ 包全是插件）。
- **API 稳定性是明确风险**：developer preview + "THERE WILL BE COMPATIBILITY-BREAKING CHANGES"；SDK 协议 "No protocol-version negotiation…pre-release stance, no compatibility promise"；SDK wire 无 cancel 方法（"a client abandons a turn by closing the runtime process"——但 gateway 的 `@Remote('cancel')` 有取消，走 web 通道可解）。黑客松 43 小时锁死一个 commit 即可规避。
- 第三方生态已萌芽：`dsh-plugin` GitHub topic、awesome-deepseek-harness 列表、社区 hooks 插件等。

### 5.3 Cordis 是什么

README 直链 **github.com/cordiverse/cordis**：一个通用 TypeScript 插件/依赖注入框架（dsh 将其 vendored 进仓库），核心概念为 plugin / service（`ctx.<key>`）/ `inject` 依赖声明 / 类型化事件 / 可逆 effect（docs/cordis-primer.md）。它并非 DeepSeek 自研新物——cordiverse 的 Cordis 此前即是开源聊天机器人框架 Koishi 的内核（背景知识，供参考）；DeepSeek 为其补了一篇设计论文（arxiv 2608.25512）。

### 5.4 异源模型 / "异源记录员"

- dsh 原生多 provider：内置 "provider ids such as `anthropic`, `openai`, `moonshotai` for Kimi, or `zai` for GLM"，另可加 custom provider（协议三选一：`openai-completions` / `openai-responses` / `anthropic-messages`），逐会话选模型（docs/user/guide/providers.md）。子 agent 的 `agentOptions` 可覆盖 provider/model——即"干活 agent 用 A 家、记录员 agent 用 B 家"在 dsh 内部就能做。
- **更推荐**：记录员根本不必是 dsh agent——它是纯消费者（读 session.event 流 + 调一次异构 LLM API 做对账摘要），做成独立进程最省事、最不受 dsh API 变动影响。

---

## 6. 总判断

**绿灯（带一条黄色警戒线）。**

四项能力对表：① 动作拦截/观测——原生四段 waterfall + 三条外部事件流通道，**超配**；② 上下文注入——`agent.inject()` / `steer()` / remote prompt，**够用**；③ 过程记录——事件溯源 + turn/step 分层 + JSONL 落盘 + 现成 Trajectory 视图，**这就是 dsh 的世界观，白捡**；④ 回滚/分支——会话级 fork 原生且远程可调、原分支留存，唯**工作区文件无快照**。

**最薄弱一环**：回滚的"物理半边"——文件系统状态。dsh 只 fork 对话，不 fork 磁盘。绕行方案现实且工作量可控：工作台监听 `turn/end` 自动 git commit/branch 打点，回滚 = remote fork + git checkout + 把指正 prompt 进子会话；对 git 外副作用在时间线上标"不可回滚"。次级风险：developer preview 的 API 漂移（锁 commit 解决）和文档密度带来的上手时间（建议第 0 小时先跑通 `dsh --profile sdk` + 事件流打印，验证主链路，再写任何 UI）。

**43 小时建议架构**：dsh（web 或 sdk profile）原样跑干活 agent（多开即多 agent）；工作台 = 独立进程，经 SDK `session.event` / gateway `follow` 收流建分层时间线；记录员 = 工作台内直调异源 API 的模块（不写成 dsh 插件）；回滚 = gateway `fork` + git 打点。需要写的 dsh 侧代码接近零，主要工程量都在工作台 UI 和对账逻辑上——这正是黑客松该花时间的地方。

---

## Sources

- 仓库主页/README：https://github.com/deepseek-ai/deepseek-harness ；raw README：https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/README.md
- 仓库元数据（创建时间/语言/star/默认分支）：https://api.github.com/repos/deepseek-ai/deepseek-harness
- 架构总览：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md
- 工具执行流水线：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-execution-pipeline.md
- Agent 生命周期时序：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/agent-lifecycle.md
- 会话事件模型 + fork API：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md
- JSONL 持久化后端：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence-jsonl/README.md
- 持久化 checkpoint 策略：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-checkpoint-policy/README.md
- Hook 协议：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/hooks/hook-protocol/README.md
- Claude Code hooks 桥：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/hooks/hooks-claude-code/README.md
- SDK 线协议：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/README.md
- TS SDK 客户端：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md
- Python SDK 指南：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/python-sdk.md
- 模型/Provider 配置：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md
- Subagent 子系统：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md
- Agent Teams（实验性）：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/agent-team.md
- 事件生产/消费矩阵：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/event-producer-consumer.md
- Cordis 入门：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.md ；Cordis 框架：https://github.com/cordiverse/cordis ；设计论文：https://arxiv.org/abs/2608.25512
- 插件开发教程：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.md
- Trajectory 视图：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-trajectory/README.md
- 会话导出：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session-query/session-log-export/README.md
- CLI/profile 参考：https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md
- 词汇表：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/glossary.md
- 生态旁证：https://github.com/truelove-dreamer/dsh-plugin-hooks ；https://github.com/0xsline/awesome-deepseek-harness
- 官方文档站（SPA，内容与仓库 docs 同源）：https://deepseek-harness.github.io/deepseek-harness/
