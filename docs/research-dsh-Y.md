# DeepSeek Harness (dsh) 作为决策流底座的可行性调研

> 2026-09-04 · 芝士。方法：浅克隆 deepseek-ai/deepseek-harness（v0.1.3-alpha.1，2026-08-13 开源，Cordis 插件框架，TS）全源码，由调研分身逐条核对代码与文档，证据均为文件路径 + 原文。
> 背景：D5 原定 Claude Agent SDK 自建壳（见 <docs/requirements-alignment-Y.md>），Yonack1 提出改用 dsh 开刀，本文评估。

## 结论

**可行，且省掉了路线 B 最大的工作量（自建界面）。** dsh 的插件口子与决策流四个需求逐条对上，cookbook 里甚至有 permission-gate 现成示例。唯一硬限制是不能改写工具入参（对我们无碍：D4 的翻案本来就走 deny + 注入）。

## 逐条对照（需求 ← dsh 能力）

| 我们要的 | dsh 提供 | 证据 |
|---|---|---|
| 执行前拿全参并阻断/否决+理由回传 | `tools/pre-execute` waterfall，`PreToolDecision = allow / deny(reason) / ask`，deny 理由物化成模型可见的 error | `packages/core/tools/src/index.ts:144,581-584,1480-1489` |
| 挂起等人审、不超时放行 | waterfall 被 `await`，agent loop 暂停；管线无内建超时；内建审批语义 **fail-closed**（只有 allowed-once 放行） | `tools/src/index.ts:1466-1469`、`agent-loop/src/tool-calls.ts:216`、`docs/subsystems/approval.md` |
| 翻案注入只向前生效 | `agent.inject(message)`：「Queue model-facing context for the next pre-step」；另有 `steer`/`followup`、工具侧 `additionalContexts` | `packages/core/agent/src/runtime-types.ts:187` |
| 紧急叫停 | `agent.cancel(cause)` 中止当前 turn | `runtime-types.ts:129` |
| 自定义 UI 面板 | Slots 系统（typed React 组合），现成 `ui-approval` 插件 93 行就是"浏览器人审面板+pending promise"全套，可直接抄 | `docs/subsystems/slots.md`、`packages/client/ui-approval` |
| 不锁死 DeepSeek 模型 | `llm-pi-ai` 适配器支持任意 OpenAI 兼容 / Anthropic，改配置即换 | `packages/llm/llm-pi-ai/README.md` |

## 工作量

- 最小可用（Host 侧拦截）：1 个新包 4 个文件，核心逻辑 50–100 行（cookbook `extension-cookbook.md` 的 permission-gate 示例字面就是这个需求）。
- 带浏览器卡片面板：+1 个 client 包，抄 `ui-approval` 形态。
- **界面大头免了**：Web UI（:3080）本来就流式渲染 agent 的每次工具调用，我们只加卡片/时间线面板，不用从零盖房子。

## 坑（开工前必读）

1. **不能改写工具入参**（设计如此，入参已落日志已渲染）→ 翻案走 deny+注入，或 scoped 影子工具。
2. 内建 `ctx.approval` 的请求**不带工具入参**且要求 open turn → 别用它，自己在 `pre-execute` 里 POST 全参给审批面板。
3. pre-execute 挂起会**卡住同批并行工具调用**（有序阶段）→ demo 场景单 agent 无碍。
4. 自定义事件不能自动桥到浏览器（Host→Client 白名单）→ 复用已桥接的 `user-questions/request`，或 `ctx.webServer.register()` 自建路由。
5. **alpha 预览版**，README 明言会有破坏性变更 → 锁死版本号，赛期内不升级。
6. 作为外部独立插件开发（不进它 monorepo），绕开它 60+ 个 verify 门禁。

## 对 D5 的影响（对比表）

| | B · Claude SDK 自建壳 | D · dsh 插件 |
|---|---|---|
| 审批挂起 | canUseTool 无限挂起 ✅ | pre-execute 无限挂起 + fail-closed ✅ |
| 界面 | **从零自建（最大工作量）** | 现成 Web UI + Slots 加面板 |
| 注入/叫停 | SDK streaming ✅ | inject/cancel ✅ |
| 框架熟悉度 | Claude Code 生态，熟 | Cordis 新框架，有学习成本 |
| 稳定性 | SDK 成熟 | alpha，锁版本可控 |
| 路演叙事 | 无光环 | 蹭 95k star 顶流生态，"给 dsh 补上决策层"故事性强 |

裁决：待 Yonack1 拍板（D5 修订）。
