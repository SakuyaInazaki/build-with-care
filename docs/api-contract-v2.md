# API 契约 v2 · 决策流工作台

> 2026-09-05 制定。本文是三份平权 requirements（`requirements-alignment.md`、`requirements-alignment-S.md`、`requirements-alignment-Y.md`）上的实现契约，不覆盖或废止 S 对异源 recorder“只标记、不阻断”的要求。后端、LLM 接入、前端三条线同时按此契约开发；任何一方需要改契约，先改本文再改代码。
> 服务只监听 `127.0.0.1:4173`。所有响应 JSON；失败统一 `{ "error": { "code": string, "message": string } }`。
> 状态码：200 成功 / 201 创建 / 202 已受理（异步）/ 400 参数错 / 403 来源禁止 / 404 不存在 / 409 冲突 / 413 过大 / 422 语义不可处理 / 500 内部错。

## 0. 名词

- **session**：一次“人指挥 agent 干活”的会话。创建时锁定纠偏模式 `mode`，不可改。
- **spec**：一句话需求 + 若干条已确认约束。确认后才允许执行动作；它是红/蓝判色的 baseline。
- **card**：每个粗粒度 step 对应一张卡。`verdict.kind` 是判官颜色（red / blue / gray），`state` 是块的流转状态（`verified` 即 green）。
- **timeline**：append-only 全局事件流，多 agent 合并，`sequence` 单调递增。
- **branch**：`rewind-and-fork` 模式下由 fork 产生；父分支保留、非活动。
- **runner**：服务器端正在驱动这个 session 的东西：`demo`（脚本演示）、`llm`（真实模型 agent）、`idle`。

## 1. 类型（TypeScript 语义）

```ts
type VerdictKind = 'red' | 'blue' | 'gray'
type CardState = 'pending' | 'allowed' | 'overridden' | 'cancelled' | 'interrupted' | 'verified' | 'failed'
type CorrectionMode = 'forward-only' | 'rewind-and-fork'
type FailureKind = 'runtime-error' | 'constraint-conflict' | 'recording-drift'

interface ConfirmedSpec { id: string; request: string; constraints: string[]; confirmed: boolean }

interface ActionInput {
  id?: string; tool: string; kind: 'write' | 'command' | 'read' | 'validate'
  description: string; args: Record<string, unknown>
  specified?: boolean; agentId?: string
}

interface Verdict { kind: VerdictKind; explanation: string; alternatives: string[]; failureKind?: FailureKind }

interface VerificationEvidence {
  cardId: string; executionId: string; source: 'executor' | 'human' | 'external'
  kind: 'test' | 'build' | 'check' | 'explicit-check'; detail: string; passed: boolean
}

interface DecisionCard {
  id: string; createdAt: string
  sessionId: string; branchId: string; agentId: string; turn: number; step: number
  action: ActionInput; verdict: Verdict
  state: CardState
  decisionStatus: 'pending' | 'allowed' | 'overridden' | 'cancelled' | 'interrupted'
  executionStatus: 'not-started' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
  verificationStatus: 'unverified' | 'passed' | 'failed'
  appliedConstraint?: string        // 人翻案时给的约束/改写
  verification?: VerificationEvidence
  failureKind?: FailureKind
  executionId?: string
  runtimeAttempts: number
  externalSideEffect: boolean
  // v2 新增
  approvalDeadline?: string         // pending 红卡的 fail-closed 截止时间 ISO；非 pending 为 undefined
  blockedHelp?: boolean             // 运行报错连续 3 次失败后升级为阻塞求助（红色运行失败）
  humanContext: {                   // 这一步发生时“人说了什么”
    request: string
    constraints: string[]
    lastAdjudication?: string       // 最近一次人的裁决文本（翻案/改写）
  }
  assessment: {                     // 记录员（异源/规则）的对账结论
    selfDirected: boolean           // agent 自作主张（人没指定）
    drift: boolean                  // 与人类指令不符
    confidence: number              // 0..1
    note: string
  }
  provenance: {                     // 谁判的色、谁记的账
    judge: string                   // 'deterministic' | 'llm:<model>' | 'llm-fallback:deterministic'
    recorder: string
  }
  postHocDecision?: {               // 事后翻案（对已执行的蓝/灰/绿卡）记录
    kind: 'allow' | 'alternative' | 'rewrite'; text?: string; at: string
  }
}

type TimelineEventType =
  | 'session-start' | 'session-end' | 'agent-registered' | 'turn-start' | 'step-start'
  | 'human-command' | 'agent-action' | 'card-created' | 'verdict'
  | 'human-adjudication' | 'injection' | 'tool-result' | 'verification' | 'failure'
  | 'branch-created' | 'fork' | 'cancel' | 'turn-end' | 'adapter-event' | 'runner'

interface TimelineEvent {
  id: string; sequence: number; at: string; type: TimelineEventType
  source: 'stream' | 'judge' | 'recorder' | 'executor' | 'human' | 'workspace' | 'runner' | 'agent'
  sessionId: string; branchId: string; agentId?: string; turn?: number; step?: number; cardId?: string
  message: string; provider?: string; version?: string; externalType?: string
  metadata?: Record<string, unknown>
}

interface Branch { id: string; parentId?: string; forkTurn?: number; active: boolean; createdAt?: string }

interface RunnerStatus {
  kind: 'idle' | 'demo' | 'llm'
  state: 'idle' | 'running' | 'waiting-human' | 'done' | 'failed' | 'cancelled'
  scenario?: 'full' | 'multi-agent' | 'red-only'
  stages?: Array<{ id: string; label: string; status: 'pending' | 'active' | 'done' | 'skipped' | 'failed' }>
  message?: string
  waitingCardId?: string          // 正在等人裁决的卡
  model?: string                  // llm runner 的模型名
  steps?: number                  // 已跑步数
  startedAt?: string; finishedAt?: string
}

interface SessionReport {
  sessionId: string; startedAt: string; endedAt?: string; durationMs: number
  decisions: number               // 非灰卡数
  allowed: number; overrides: number; cancelled: number
  selfDirected: number; recordingDeviations: number; verified: number; branches: number
  runtimeFailures: number; blockedHelp: number; verificationEvidence: number
  irreversibleSideEffects: number; unverified: number; recordingFailures: number
  humanDecisions: number          // 人做的判断次数（spec 确认 + 裁决 + 事后翻案 + 叫停）
  agentDecisions: number          // agent 自主拍板次数（selfDirected）
  directionCorrections: number    // 其中纠正了跑偏方向的次数（红卡被 alternative/rewrite）
  byColor: { red: number; blue: number; gray: number; green: number; failed: number }
  perAgent: Array<{ agentId: string; actions: number; selfDirected: number; red: number; blue: number; gray: number; verified: number; failed: number }>
  corrections: Array<{ cardId: string; turn: number; agentId: string; kind: 'allow' | 'alternative' | 'rewrite' | 'cancel'; before: string; after: string; mode: CorrectionMode; at: string; branchId: string; postHoc: boolean }>
  summary: string
  events: TimelineEvent[]
}

interface SessionState {
  sessionId: string; mode: CorrectionMode; title: string; createdAt: string; endedAt?: string
  spec?: ConfirmedSpec
  cards: DecisionCard[]; timeline: TimelineEvent[]; branches: Branch[]
  agents: string[]
  runner: RunnerStatus
  report: SessionReport
}

interface SessionSummary {
  sessionId: string; mode: CorrectionMode; title: string; createdAt: string; endedAt?: string
  request?: string
  counts: { cards: number; pending: number; red: number; blue: number; gray: number; green: number; failed: number }
  agents: string[]
  runner: RunnerStatus['state']
}
```

## 2. 路由

### 全局
- `GET /api/config` →
  ```json
  { "version": "0.2.0",
    "approvalTimeoutMs": 600000,
    "llm": { "agent": { "configured": false, "provider": null, "model": null },
             "judge": { "configured": false, "provider": null, "model": null },
             "recorder": { "configured": false, "provider": null, "model": null } },
    "dsh": { "installed": false, "version": null, "diagnostic": "..." },
    "workspaceRoot": ".decision-stream/workspaces" }
  ```

### session
- `POST /api/sessions` body `{ "mode": "forward-only" | "rewind-and-fork", "title"?: string }` → 201 `SessionState`
- `GET /api/sessions` → 200 `SessionSummary[]`（按 createdAt 倒序）
- `GET /api/sessions/:id/state` → 200 `SessionState`
- `GET /api/sessions/:id/events` → **SSE**（`text/event-stream`）。连接后立刻发一条 `event: state`（data = 完整 SessionState），之后：
  - `event: timeline` data = 一条新 `TimelineEvent`
  - `event: update` data = `{ cards, branches, spec, report, runner, endedAt, agents }`（任何卡/分支/runner 变化后发一次，可与 timeline 合并发送）
  - `event: ping` 每 15 秒
  - 前端应在 SSE 断开时退化为每 1.5 s 轮询 `/state`。
- `POST /api/sessions/:id/spec` body `ConfirmedSpec`（`confirmed` 必须为 true）→ 200 `SessionState`；已确认过再确认 → 409。
- `POST /api/sessions/:id/spec/draft` body `{ "request": string }` → 200 `{ "request": string, "constraints": string[], "source": "llm" | "template" }`。把一句话需求扩成 2–4 条短约束供人确认（无模型时用模板规则）。
- `POST /api/sessions/:id/end` → 200 `SessionState`（写入 `session-end`，冻结 session：之后任何执行类请求 409；report 视为最终）。
- `POST /api/sessions/:id/cancel` → 200 `SessionState`（紧急叫停：取消所有 pending gate、终止 runner；session 不冻结，仍可 end）。

### 执行
- `POST /api/sessions/:id/actions` body `ActionInput` → 202 `SessionState`（判色可能异步；前端靠 SSE / 轮询）。未确认 spec → 409；session 已 end → 409。
- `POST /api/sessions/:id/demo` body `{ "scenario": "full" | "multi-agent" | "red-only", "pace"?: number }` → 202 `{ "ok": true, "scenario": string }`。
  - 服务器端异步驱动，`runner.kind = 'demo'`；遇红卡进入 `waiting-human` 并停下，人裁决后继续；人叫停则 `cancelled`。
  - `full` 阶段：blue（缓存自主选择）→ red（SQLite 冲突阻断）→ correction（按模式注入/fork）→ tool（写 Postgres schema）→ evidence（本地检查 → green）→ runtime-failure（跑 `npm test` 三次失败升级求助）→ complete。
  - `multi-agent`：3 个 agent 并发交错（灰/蓝/红 各至少一张），验证全局时间线合并。
  - `red-only`：只产生一张 `demo-red` 红卡（兼容旧行为）。
  - 已有 runner 在跑 → 409。
- `POST /api/sessions/:id/run` body `{ "request"?: string, "maxSteps"?: number }` → 202 `{ "ok": true, "model": string }`。启动真实 LLM agent loop（`runner.kind='llm'`）。未配置模型 → 409 `llm_not_configured`。

### 裁决
- `POST /api/sessions/:id/cards/:cardId/decision` body `{ "kind": "allow" | "alternative" | "rewrite" | "cancel", "text"?: string }` → 200 `SessionState`
  - 卡 pending（红卡 gate）：与 v1 相同：allow 放行执行；alternative/rewrite 拒绝原动作并（forward-only）注入后续约束 / （rewind-and-fork）从已完成 turn 边界 fork；cancel 叫停这张卡。
  - 卡已执行完（蓝/灰/绿/失败求助）：**事后翻案**。alternative/rewrite → 记 `human-adjudication` + `injection`（forward-only 只影响后续）或 fork（rewind：边界 = `card.turn - 1`）；allow → 记“人已确认放过”；cancel → 409（已执行的不能叫停）。写入 `card.postHocDecision`。
  - 重复相同裁决幂等 200；冲突裁决 409。
- `POST /api/sessions/:id/cards/:cardId/cancel` → 200（仅 pending）
- `POST /api/sessions/:id/verify` body `{ "cardId": string, "passed": boolean, "detail"?: string }` → 200。人工复核记录为 `source: 'human'`，**不会**变 green。
- `POST /api/sessions/:id/rewind` body `{ "turnBoundary": number, "instruction": string }` → 200 `SessionState & { result }`；非 rewind 模式 409；边界非已完成 turn 409。
- `POST /api/sessions/:id/adapter-events` body dsh wire event → 202 `SessionState`；lifecycle events are appended as adapter events, while `tool-result` is authoritative for external work-unit execution and is the only event allowed to mark a dsh call succeeded/green。

### 查询
- `GET /api/sessions/:id/timeline?agentId=&branchId=&eventType=&since=<sequence>` → 200 `TimelineEvent[]`
- `GET /api/sessions/:id/branches` → 200 `Branch[]`
- `GET /api/sessions/:id/report` → 200 `SessionReport`

### 静态
- `GET /` → `public/index.html`；`GET /<file>` 按扩展名给正确 `content-type`（html/css/js/mjs/svg/png/woff2/json/ico），禁止越出 public。

## 3. 约束与边界（所有线都要守）

1. 审批超时默认 10 分钟（环境变量 `DECISION_STREAM_APPROVAL_TIMEOUT_MS`），超时 fail-closed 记 `cancel`。前端要显示倒计时。
2. 执行器工作区 = `<dataRoot>/workspaces/<sessionId>/`，demo/LLM 的写文件都落在那里，不污染仓库。
3. 时间线 append-only；任何“纠偏”都是新增事件，不改旧事件。
4. 只有 executor 绑定的 `passed` evidence 才 green；人工复核永远不是 green。
5. `rewind-and-fork` 的逻辑 fork 不回滚物理文件、不撤销外部副作用；UI 要明示。
6. 没有配置模型时，一切功能可用（deterministic judge/recorder + 脚本 demo）；配置了模型时，判官/记录员/agent 才切换到真模型，卡片 `provenance` 标明来源。recorder 负责异源记录与 drift 对账，非阻断；policy safety net 是独立的执行安全约束，命中明确冲突时才阻断。
7. 页面不得依赖任何外网 CDN（现场可能没网）。
