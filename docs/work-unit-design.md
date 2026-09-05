# 契约附录 §4 · 工作单元级决策 + 结构化约束匹配

> 2026-09-05 14:05 由用户拍板：判官从「命令级」改为「工作单元级」。本附录是三份平权 requirements 上的实现契约，优先于 `docs/api-contract-v2.md` 中与之冲突的描述；未提及处沿用 v2，不覆盖或废止 S 对异源 recorder“只标记、不阻断”的要求。
> 参考成熟 agent 项目的做法：OpenHands / SWE-agent 的 trajectory 是「action → observation」的分段序列；LangGraph 的 human-in-the-loop 在**节点/超步**边界 `interrupt()`，不在每个工具调用上打断；Claude Code / dsh 的 turn → step 天然分层。我们的粗粒度单位叫 **工作单元（work unit）**：一个语义子目标 + 它拍的板 + 它要做的一串细粒度工具调用。**人只在单元边界拍板；单元内的工具调用只做安全网。**

## 4.1 为什么改

- 命令级判官 = 每个 `write_file` 都判一次色 → 卡片刷屏 → 审批疲劳（research.md 实锤）。
- 文本正则判色（`sqlite` 出现即红）解释力弱、误报多（"不用 sqlite" 也会红）。
- 工作单元级 + 结构化匹配：卡片数 = 语义步骤数；判色 = 「决策域 × 选择」对「决策域 × 约束」的精确匹配，每一次红都能说出「存储：约束要求 postgres，agent 选了 sqlite」。

## 4.2 类型

```ts
/** agent 在一个单元里拍的板。domain 是决策域，choice 是规范化选择（小写、别名归一）。 */
interface StructuredDecision {
  domain: string            // 'storage' | 'cache' | 'auth' | 'frontend-framework' | 'language' | 'api-style' | 'testing' | 'deploy' | 'external-side-effect' | 其他自由字符串
  choice: string            // 'sqlite' | 'postgres' | 'jwt' | 'session' | 'memory-cache' | ...（走 judge.ts 的 TECH_ALIASES 归一）
  rationale?: string        // agent 自述理由（进卡片文案）
  specifiedByHuman?: boolean // agent 声称是人指定的；判官只在约束/spec 真的提到时才认
  extracted?: boolean       // true = 不是 agent 自报，而是从工具调用文本里抽出来的（置信度低）
}

/** 人的约束，结构化后才参与匹配。文本仍保留，UI 显示文本，匹配用结构。 */
interface StructuredConstraint {
  id: string
  domain: string
  kind: 'require' | 'forbid' | 'prefer'   // prefer = 软约束：违反只出蓝卡并附注，不红
  values: string[]                         // 规范化
  text: string                             // 人的原话
  source: 'spec' | 'adjudication' | 'draft'
  createdAt: string
  affectsFromTurn?: number                 // forward-only：只约束此 turn 之后开始的单元
}

interface WorkUnitInput {
  id?: string
  agentId?: string
  goal: string                       // 粗粒度语义，如「为报名信息选择并落地存储方案」
  decisions: StructuredDecision[]    // 可为空 = 纯执行单元（灰）
  toolCalls: ActionInput[]           // 细粒度动作，按序执行（可为空：纯决策单元）
  summary?: string
}

/** 每个决策对约束的匹配结果，卡片上逐条展示。 */
interface DecisionMatch {
  decision: StructuredDecision
  constraintId?: string
  outcome: 'forbidden' | 'required-mismatch' | 'required-match' | 'preference-mismatch' | 'human-specified' | 'unconstrained'
  explanation: string               // 中文一句话
}

interface UnitToolCall {
  action: ActionInput
  status: 'not-started' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'blocked'
  executionId?: string
  result?: { ok: boolean; output?: unknown; error?: string }
  evidence?: VerificationEvidence
  safetyNet?: { outcome: DecisionMatch['outcome']; explanation: string }   // 单元内未申报却触碰约束时记录
  attempts: number
}

// DecisionCard 新增：
//   unit?: { goal: string; decisions: StructuredDecision[]; matches: DecisionMatch[]; toolCalls: UnitToolCall[]; summary?: string }
//   verdict.matches 与 unit.matches 同源；verdict.explanation 由 matches 拼成。
// ConfirmedSpec 新增：
//   structuredConstraints: StructuredConstraint[]   // 服务器在 /spec 时从 constraints 文本派生；客户端也可直接提供
```

## 4.3 匹配规则（确定性、可解释）

对单元里每个决策 `d`，取同 `domain` 的约束（找不到同域时，退而按 `values` 含 `d.choice` 的任意约束）：

| 情况 | 结果 |
|---|---|
| 有 `forbid` 且 `values ∋ d.choice` | `forbidden` → **红** |
| 有 `require` 且 `values ∌ d.choice` | `required-mismatch` → **红**，备选项 = `改用 <required values>` |
| 有 `require` 且 `values ∋ d.choice` | `required-match` → 灰（人指定的） |
| `d.specifiedByHuman` 且 spec 原文/约束提到 `d.choice` | `human-specified` → 灰 |
| 有 `prefer` 且 `values ∌ d.choice` | `preference-mismatch` → **蓝**（附注「偏离偏好」） |
| 无约束 | `unconstrained` → **蓝**（agent 自主拍板） |

单元颜色 = 所有决策里最严重者（红 > 蓝 > 灰）；无决策且工具调用只有 read/validate → 灰；无决策但有 write/command → 蓝（"做了事但没申报决策"，抽取器补决策）。

`forward-only` 的 `affectsFromTurn`：单元 `turn ≤ affectsFromTurn` 的不受该约束影响（历史不改写）。

## 4.4 抽取器（fallback，保持诚实）

没有结构化决策的输入（旧的 `POST /actions`、dsh 原始工具调用、脚本 demo 未声明时）走 `extractDecisions(action)`：用 `judge.ts` 现有 tokenizer + `TECH_ALIASES` + `COMPETITOR_GROUPS` 找已知技术词 → `{ domain: 组名, choice: 词, extracted: true }`。`COMPETITOR_GROUPS` 每组加上 domain 名：storage / cache / frontend-framework / language / auth。抽取来的决策置信度标低（`assessment.confidence ≤ 0.7`），卡片文案写「从工具调用推断」。

约束文本 → 结构：`parseConstraint(text)` 已有 forbidden/required 词表，映射到域；映射不到的词 → `domain: 'other'`，按值匹配。人的裁决：
- `alternative` 文本形如「改用 X」→ `{ domain: 被翻决策的域, kind: 'require', values: [X], source: 'adjudication' }`
- `rewrite` 自由文本 → 先 `parseConstraint`；解析不出任何词时，**最低限度**生成 `{ domain: 被翻决策的域, kind: 'forbid', values: [被翻的 choice] }`（翻案至少禁掉被翻的选择）。
- 有模型时 `spec/draft` 与裁决解析优先走 LLM 输出结构（`src/llm/**`），失败回退规则。

## 4.5 单元的执行与安全网

记录员的对账仍是独立的非阻断标记：它可以记录 self-directed 或 drift，但不能仅因该结论阻止执行。下面的 policy safety net 不等同于 recorder；它基于实际工具调用与结构化约束的明确冲突，作为独立安全策略阻断调用并升级卡片。

`DecisionStream.executeUnit(unit)`：
1. 注册 agent，`turn++`；记录员对账；判官按 4.3 出 `matches` → 单元卡（一张卡）。
2. 红 → gate 挂起（同 v2：allow / alternative / rewrite / cancel，超时 fail-closed）。alternative/rewrite → 单元**整体不执行**，约束入库；forward-only 注入、rewind-and-fork 分叉。
3. 放行/蓝/灰 → 按序执行 `toolCalls`，每个调用：
   - 先过**安全网**：`extractDecisions(call)` 得到的决策若命中 `forbidden` / `required-mismatch`，且该决策未在单元里申报 → 该调用 `blocked`，卡片升级为红（运行中约束冲突，`failureKind: 'constraint-conflict'`），进入 gate 等人；同时记录员标 `drift`（申报与实际不符）。
   - 通过 → executor 执行；失败重试 3 次 → `blockedHelp`；`validate`/命令带 evidence 且 passed → 绿（单元级 `verificationStatus`，任一 evidence 通过即可，UI 展示是哪一个）。
   - 每个调用产生 `tool-call` / `tool-result` 事件，`cardId` 指向单元卡（细粒度可展开）。
4. `turn-end`。

旧接口 `execute(action)` = `executeUnit({ goal: action.description, decisions: extractDecisions(action), toolCalls: [action] })`，现有测试语义不变。

## 4.6 路由增量

- `POST /api/sessions/:id/units` body `WorkUnitInput` → 202 `SessionState`
- `POST /api/sessions/:id/spec` 接受 `constraints: string[]` 和/或 `structuredConstraints: StructuredConstraint[]`；响应里 `spec.structuredConstraints` 一定存在。
- `POST /api/sessions/:id/constraints` body `{ text?: string, structured?: StructuredConstraint }` → 200：人随时补约束（等价于一次 injection，只影响后续）。
- 卡片事件新增 `tool-call`（`TimelineEventType` 加 `'tool-call'`）。
- `/demo` 的 `full` 与 `multi-agent` 场景改为按单元发：
  - U1 `agent-research`「选择缓存方案」decisions `[{cache: memory-cache}]`，toolCalls `[write config/cache.json]` → 蓝
  - U2 `agent-builder`「为报名信息落地存储」decisions `[{storage: sqlite}]`，toolCalls `[write store/db.sqlite, write store/schema.sql]` → 红，等人
  - 人 alternative「改用 postgres」→ 约束入库 → U3 `agent-builder`「按人的裁决落地 Postgres 存储」decisions `[{storage: postgres, specifiedByHuman: true}]`，toolCalls `[write store/db.sql, validate]` → 灰→绿
  - U4 `agent-verifier`「运行测试」decisions `[]`，toolCalls `[command npm test]` → 三次失败升级求助
  - multi-agent：三 agent 各自 1–2 个单元并发，其中一个单元内**未申报**却写 `db.sqlite` → 触发安全网（演示"申报与实际不符"）。

## 4.7 各线要做的事

- **后端线**：`src/work-unit.ts`（类型 + `matchDecisions` + `extractDecisions` + `structureConstraint`），`DecisionStream.executeUnit`，安全网，`/units` `/constraints` 路由，spec 结构化，demo runner 改单元，测试（含 4.3 每一行、安全网、forward-only `affectsFromTurn`、rewrite 解析失败的最低限度约束）。
- **LLM 线**：runner 加 `begin_unit(goal, decisions[])` / `end_unit(summary)` 工具；`begin_unit` 调 `executeUnit`（toolCalls 为空的纯决策单元先过 gate），被拒返回 `DENIED:` 与约束；单元内的后续工具调用带 `unitId` 走 `stream.executeInUnit(unitId, action)`（后端提供；未提供前用 `execute(action)` 并在 args 里带 `unitId`）；judge/recorder/spec-draft 的 LLM 输出改为结构化决策/约束 JSON。系统提示词要求：**先申报后动手**。
- **前端线**：卡 = 单元：标题是 `goal`，下面是决策 chips（域 · 选择 · 匹配结果着色），展开是工具调用列表（每条状态/结果/证据/安全网标记）；spec 面板显示结构化约束 chips（域 / require·forbid·prefer / 值）并可增删（`/constraints`）；红卡文案用 `matches[].explanation`。
- **dsh 线**：插件按 dsh step 分段成单元（一次模型响应的全部工具调用 = 一个单元），决策来自新注册的 `declare_decision(domain, choice, rationale)` 工具（系统提示词要求先申报），没有申报时走抽取器；**禁用 dsh 自带的 `ask_user_question`**（在 `tools/pre-execute` 里 deny，理由「请通过决策流卡片与人沟通」，并/或在插件配置里把它从工具表移除），使所有人机交互只经过我们的卡片。
