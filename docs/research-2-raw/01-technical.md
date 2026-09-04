# 「决策流 Decision Stream」技术可行性核查报告

> 二轮调研原始结果 · 2026-09-04
> 依据：Claude Code 官方文档（code.claude.com，2026-09 现行版）、官方 SDK 类型定义（unpkg `@anthropic-ai/claude-agent-sdk/sdk.d.ts`）、本机 Claude Code v2.1.2xx 真实 transcript JSONL 实测。

## 1. PreToolUse hook 能力（机制①的核心通道）——✅ 全部成立

来源：https://code.claude.com/docs/en/hooks 、https://code.claude.com/docs/en/hooks-guide

- **完整 tool input**：✅ hook stdin 收到完整 JSON，含 `tool_name`、`tool_input`（Bash 的 `command`/`description`、Write 的 `file_path`/`content`、Edit 的 `old_string`/`new_string` 全量内容）、`tool_use_id`、`session_id`、`transcript_path`、`cwd`、`permission_mode`。注意拿到的是 Edit 的 old/new 字符串而非现成 diff，diff 需自己算（trivial）。
- **返回决定**：✅ stdout 输出 `hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" | "deny" | "ask" | "defer", permissionDecisionReason, updatedInput }`。`deny` 的 reason 会回传给模型（模型会据此调整，这正是"翻案理由"的天然通道）；`updatedInput` 还能直接改写工具入参。多 hook 合并时最严者胜：`deny > defer > ask > allow`。
- **阻塞等人审**：✅ 同步 hook 默认阻塞整个 agent loop 直到 hook 进程退出。hook 脚本可以长轮询本地审批服务。默认超时 600s（command 类型），可用每个 hook 的 `timeout` 字段配置。另有第四值 **`permissionDecision: "defer"`**（headless `-p` 模式）：进程退出并保留 pending tool call，之后从持久化 session 恢复——官方就是为"人审可能很久"设计的（https://code.claude.com/docs/en/hooks#defer-a-tool-call-for-later ，https://code.claude.com/docs/en/agent-sdk/user-input 有明确指引）。
- **超时行为（关键风险）**：⚠️ PreToolUse hook 超时后**输出被丢弃，不阻止工具调用**，落回正常权限流程——即审批网关是 **fail-open** 的。必须把超时设够长，或在 settings.json 的 `ask` 规则/权限模式上加第二道兜底。

## 2. 上下文注入通道（机制②"只向前生效"）——✅ 存在，且天然只向前

来源：https://code.claude.com/docs/en/hooks（Decision control 各事件小节）、https://code.claude.com/docs/en/agent-sdk/hooks

| 事件 | 可用输出 | 对机制②的意义 |
|---|---|---|
| `UserPromptSubmit` | `hookSpecificOutput.additionalContext`（必须嵌套在 hookSpecificOutput 里，放顶层会被静默忽略）、`updatedInput`（改写用户 prompt）、`decision: "block"` | 每轮把当前生效的"翻案约束清单"注入 |
| `PostToolUse` | `hookSpecificOutput.additionalContext`（追加到 tool result 给 Claude 看）、`updatedToolOutput`（替换工具输出）、exit 2 → stderr 喂给 Claude | 翻案后立刻在下一步生效的注入点（SDK hooks 文档原文："For PostToolUse hooks, you can set additionalContext to append information to the tool result"；注：一次对 CLI hooks 长页的摘要抓取称 PostToolUse 不支持 additionalContext，与 SDK 页原文矛盾，建议开工首日 10 分钟实测确认——即使不支持，exit 2 + stderr 通道确定存在） |
| `Stop` | `decision: "block"` + reason（阻止停止、继续对话）、`systemMessage` | 收尾卡点：强制 agent 处理未消化的翻案 |
| PreToolUse `deny` 的 `permissionDecisionReason` | 直接作为该次调用被拒的理由回传模型 | 翻案即时生效的最短路径 |

所有注入都是往对话后续追加 system-reminder / tool result 文本，**不存在回滚已完成工作的机制**——与"翻案不回滚，只约束后续"的产品设定完全同构。文档原文："Text returned via additionalContext is injected as a system reminder that Claude reads as plain text"（hooks 参考页）。

## 3. Agent SDK 路线（TS/Python）——✅ 机制①②都显著更顺

来源：https://code.claude.com/docs/en/agent-sdk/overview 、/agent-sdk/permissions 、/agent-sdk/user-input 、/agent-sdk/hooks 、/agent-sdk/streaming-vs-single-mode

- **canUseTool**：进程内 async 回调，`(toolName, input, {signal, suggestions, toolUseID, ...}) => Promise<PermissionResult>`；返回 `{behavior:"allow", updatedInput, updatedPermissions}` 或 `{behavior:"deny", message, interrupt?: boolean}`（unpkg sdk.d.ts 逐字核实）。官方文档原文："**The callback can stay pending indefinitely.** Execution remains paused until your callback returns"——即人审卡片可以无限期挂起，不受 hook 超时约束，**没有 fail-open 问题**。deny 的 `message` 给 Claude 解释翻案理由，`interrupt: true` 可直接打断。
- **注意坑**：被 allow 规则 / acceptEdits / bypassPermissions 预先放行的调用**不会**触达 canUseTool；要保证每个卡点都过卡片，官方明确建议改用 **PreToolUse hook（进程内回调函数，非 shell）**，它先于整条权限链执行（/agent-sdk/permissions "How permissions are evaluated" 六步顺序：Hooks → deny → ask → mode → allow → canUseTool）。SDK 的 hook 回调同样支持 `permissionDecision`/`updatedInput`/`additionalContext`。
- **Streaming input + steering**：streaming 模式（`prompt` 传 AsyncIterable / `ClaudeSDKClient`）支持随时注入新 user 消息、队列消息、`interrupt()`、`setPermissionMode()` 动态换模式——"翻案后向前注入约束"可以直接作为一条新 user/system 消息插进对话，比 CLI 的 hook 注入更直接（/agent-sdk/streaming-vs-single-mode："Interrupt the agent mid-task / Provide additional context"）。Python 侧 `can_use_tool` 要求 streaming 模式，且有限消息流需一个 dummy PreToolUse hook 保持流打开（/agent-sdk/user-input 页 Note，坑已有官方 workaround）。
- 结论：**SDK 路线下机制①②确实更容易**——无限期挂起审批、进程内状态共享（不用 hook 脚本 ↔ 审批服务的 IPC）、随时注入消息。

## 4. Plan baseline（plan mode / ExitPlanMode 产物）——✅ 可拿到，有一处需开工实测

- SDK 有 `permissionMode: "plan"`；plan 模式下文件写操作强制走 canUseTool（https://code.claude.com/docs/en/agent-sdk/permissions#plan-mode-plan）。
- `ExitPlanMode` 是普通工具、需要 permission（https://code.claude.com/docs/en/tools-reference），因此 PreToolUse / PermissionRequest hook 和 canUseTool 都能拦到它；官方 hooks-guide 就有 `matcher: "ExitPlanMode"` 的 PermissionRequest hook 示例（https://code.claude.com/docs/en/hooks-guide#auto-approve-specific-permission-prompts）。
- **plan 文本**：官方 reference 未写出其 input schema。社区逆向分析（[how-claude-code-works: plan mode](https://github.com/Windy3f3f3f3f/how-claude-code-works/blob/main/en/docs/10-plan-mode.md)）与相关 issue（[#12288](https://github.com/anthropics/claude-code/issues/12288)、[#21282](https://github.com/anthropics/claude-code/issues/21282)）显示：新版中 plan 先写盘，Claude Code 在传给 hook 前把 `plan` 和 `planFilePath` 注入 tool_input（发 API 前再剥离）；PostToolUse 的 `tool_response` 含 `plan`/`filePath`。同时 plan 全文必然出现在 transcript JSONL 的 tool_use 记录里，双保险。**建议列为 Day 1 的 10 分钟验证项**。
- 每个 hook 输入都带 `permission_mode` 字段（值含 `"plan"`），可据此区分"按 plan 执行期"与"自由发挥期"。

## 5. Transcript JSONL 重建翻案记录（机制③）——✅ 结构充分（本机实测）

对本机 `~/.claude/projects/<project>/<session-id>.jsonl` 实测（Claude Code v2.1.224/2.1.259）：

- 每条消息有 `uuid` / `parentUuid`（构成因果链）、`timestamp`、`sessionId`、`promptId`、逐消息的 `permissionMode`、`gitBranch`、`cwd`、`version`；
- `type: "user" | "assistant" | "attachment" | "system"` 等；assistant 消息内含完整 `tool_use` block（含 input 全文），对应 `tool_result` 记录带 `tool_use_id`、`toolUseResult`（stdout/stderr/interrupted）、`is_error`；
- 用户消息带 `origin: {kind: "human"}` / `promptSource`，可区分人类输入与注入；hook 拒绝会以带拒绝理由的 tool_result 落盘（hooks-guide 也提到 transcript 显示 "Allowed by PermissionRequest hook"）。
- 结论：事后能重建"第 N 步 agent 想做 X（tool_use input 全文）→ 被 deny + 理由 Y（tool_result）→ 后续行为改变"。**但格式无官方稳定性承诺**；更稳做法是审批服务自己顺手落一份决策卡+裁决日志（反正卡片都经过它），transcript 只做补充取证。每个 hook 输入自带 `transcript_path`，读取零成本。

## 6. 架构路线建议

### 路线 A：CLI + settings.json hooks + 本地审批 Web UI（推荐，最稳）

PreToolUse(matcher: `Write|Edit|Bash|ExitPlanMode`) → hook 脚本 POST 卡片到 localhost 审批服务并长轮询 → 返回 allow/deny(+reason)；UserPromptSubmit/PostToolUse 注入在案约束；审批服务落库生成报告页。

- **工作量**：1 人日核心跑通（hook 脚本 + 一个 FastAPI/Express + 简单前端），剩余时间打磨卡片生成（可用 prompt-based hook 或小模型把 tool_input 变成"我准备做X因为Y"卡片）与报告。
- **最大风险**：hook 超时 fail-open（超时→放行）；人审慢于 timeout 上限时体验断裂。缓解：timeout 拉满 + `ask` 兜底规则。
- **优点**：不动 agent loop，演示时就是原生 Claude Code 体验，评委可信度高。

### 路线 B：Agent SDK（TS）自建 harness + Web 前端

`query()` streaming + 进程内 PreToolUse hook（保证全覆盖）+ canUseTool 无限期挂起等审批 + 翻案后直接注入新 user 消息 + 全部状态在自己进程里 → 报告零解析成本。

- **工作量**：1.5–2 人日（要自己做输入/输出流 UI 或接队友前端），但机制①②③实现都最干净。
- **最大风险**：把"重建一个可看的对话界面"低估了；Python 侧 streaming/dummy-hook 的坑（选 TS 可避开大半）。

### 路线 C：CLI headless `-p` + `defer` + SDK resume（审批可跨进程/异步）

- 最贴合"审批可能几小时"的真实产品形态，但 defer/resume 是最新特性、文档薄、踩坑成本不可控。**黑客松不建议作主线**，可作为 demo 里的一页"生产化路径"。

**两天半结论：主线走 A**（半天内可出第一个端到端 demo，失败面最小），若队里有熟 TS 的人，用 B 做"翻案即时注入 + 打断"的高光片段；③无论哪条路都由审批服务自己的日志生成，transcript 只做交叉验证。

**开工首日必做的两个 10 分钟实测**：① ExitPlanMode 的 hook input 里 `plan` 字段是否如社区所述存在；② PostToolUse 的 `additionalContext` 在当前 CLI 版本是否生效（两处文档表述有出入，均有替代通道兜底）。

## Sources

[Hooks reference](https://code.claude.com/docs/en/hooks) · [Hooks guide](https://code.claude.com/docs/en/hooks-guide) · [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) · [Permissions](https://code.claude.com/docs/en/agent-sdk/permissions) · [User input / canUseTool](https://code.claude.com/docs/en/agent-sdk/user-input) · [SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks) · [Streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) · [Tools reference](https://code.claude.com/docs/en/tools-reference) · [how-claude-code-works plan mode](https://github.com/Windy3f3f3f3f/how-claude-code-works/blob/main/en/docs/10-plan-mode.md) · [issue #12288](https://github.com/anthropics/claude-code/issues/12288) · [issue #21282](https://github.com/anthropics/claude-code/issues/21282)
