/**
 * Pure mapping between dsh's tool-execution pipeline and the Decision Stream
 * workbench API (docs/api-contract-v2.md). No I/O here so it can be unit tested
 * without dsh or the workbench.
 *
 * dsh side (0.1.3-alpha.1):
 *   - `tools/pre-execute` waterfall receives a `ToolExecution` with
 *     `callId`, `name`, `arguments` (parsed, deep-frozen), `agent?`, `signal`
 *     (packages/core/tools/src/index.ts:307-377) and must return a
 *     `PreToolDecision` = allow | deny(reason) | ask (index.ts:581-584).
 *   - session events are `{ type, seq, time, data }` (packages/core/session/src/types.ts:391).
 */

export const DSH_PROVIDER = 'deepseek-harness'
export const DSH_TARGET_VERSION = '0.1.3-alpha.1'
export const DSH_TARGET_COMMIT = 'd347e70390'

export type ActionKind = 'write' | 'command' | 'read' | 'validate'

/** `ActionInput` from docs/api-contract-v2.md §1. */
export interface ActionInput {
  id?: string
  tool: string
  kind: ActionKind
  description: string
  args: Record<string, unknown>
  specified?: boolean
  agentId?: string
}

/** The subset of a dsh `ToolExecution` the bridge needs (structural, no dsh import). */
export interface ToolCallLike {
  callId: string
  name: string
  arguments: unknown
  agentId?: string
  turn?: number
  step?: number
}

/** The subset of a workbench `DecisionCard` the bridge reads. */
export interface CardLike {
  id: string
  state: 'pending' | 'allowed' | 'overridden' | 'cancelled' | 'interrupted' | 'verified' | 'failed'
  decisionStatus?: string
  appliedConstraint?: string
  agentId?: string
  verdict?: { kind: 'red' | 'blue' | 'gray'; explanation?: string }
}

export type GateDecision = { kind: 'allow' } | { kind: 'deny'; reason: string }

/** dsh wire event shape consumed by `src/adapters/dsh.ts#mapDshEvent` in the workbench repo. */
export interface DshWireEvent {
  type: string
  sessionId: string
  sequence: number
  /** Original dsh session sequence when `sequence` is replaced by the bridge transport order. */
  sourceSequence?: number
  at: string
  agentId?: string
  turn?: number
  step?: number
  source: 'session.event' | 'session.lifecycle' | 'decision-stream'
  provider: string
  version: string
  payload?: unknown
}

/**
 * Tools that only observe (never mutate the workspace or run commands). They are
 * gray by product rule ("灰卡只进日志") and are NOT posted as actions by default:
 * the current workbench backend would try to `readFile(args.path)` from the
 * server's own cwd for `kind: 'read'` cards and mark them failed.
 */
export const OBSERVE_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read', 'read_image', 'glob', 'grep', 'web_fetch', 'web_search', 'lsp',
  'list_agents', 'list_subagent_models', 'job_list', 'job_output',
  'session_event_read', 'session_event_search', 'session_event_trace', 'session_search', 'session_trace',
  'get_goal', 'team_task_get', 'team_task_list', 'terminal_list', 'terminal_read', 'cordis_inspect_list',
  'cordis_inspect_query', 'cordis_inspect_self',
])

const WRITE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit', 'str_replace_editor', 'todo_write'])

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** Classify a dsh tool call into the workbench's `ActionKind` plus whether it is observe-only. */
export function classifyTool(name: string, args: unknown): { kind: ActionKind; observeOnly: boolean } {
  const a = record(args)
  if (name === 'str_replace_editor' && a.command === 'view') return { kind: 'read', observeOnly: true }
  if (OBSERVE_ONLY_TOOLS.has(name)) return { kind: 'read', observeOnly: true }
  if (WRITE_TOOLS.has(name)) return { kind: 'write', observeOnly: false }
  return { kind: 'command', observeOnly: false }
}

const clip = (text: string, max = 120): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** Short human-readable description for the card ("Agent 准备…"). */
export function describeToolCall(name: string, args: unknown): string {
  const a = record(args)
  const path = typeof a.file_path === 'string' ? a.file_path : typeof a.path === 'string' ? a.path : undefined
  if (name === 'bash' || name === 'pwsh') {
    const description = typeof a.description === 'string' && a.description.trim() ? a.description.trim() : undefined
    const command = typeof a.command === 'string' ? a.command.split('\n')[0]!.trim() : ''
    return clip(`${name}: ${description ?? command}`)
  }
  if (name === 'str_replace_editor') return clip(`str_replace_editor ${String(a.command ?? '')} ${path ?? ''}`.trim())
  if (path) return clip(`${name} ${path}`)
  return clip(`${name} ${JSON.stringify(a)}`)
}

/** Stable, URL-safe card id derived from dsh's call id. */
export function cardIdForCall(callId: string): string {
  return `dsh-${callId.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

export interface ToActionOptions {
  /**
   * Nest the raw tool arguments under `args.arguments` (default true). Required
   * against the current backend, whose `LocalAgentExecutor` would otherwise act on
   * a top-level `args.path` / `args.command` from the server's own cwd. The judge
   * still sees the arguments (it inspects `JSON.stringify(args)`).
   */
  nestArguments?: boolean
}

/** Map a dsh tool call to the workbench `ActionInput`. */
export function toActionInput(call: ToolCallLike, options: ToActionOptions = {}): ActionInput {
  const nest = options.nestArguments ?? true
  const raw = record(call.arguments)
  const { kind } = classifyTool(call.name, call.arguments)
  const dsh = { callId: call.callId, tool: call.name, turn: call.turn, step: call.step, provider: DSH_PROVIDER, version: DSH_TARGET_VERSION }
  const args: Record<string, unknown> = nest
    ? { source: 'dsh', ...dsh, arguments: raw }
    : { ...raw, source: 'dsh', ...dsh }
  return {
    id: cardIdForCall(call.callId),
    tool: call.name,
    kind,
    description: describeToolCall(call.name, call.arguments),
    args,
    ...(call.agentId ? { agentId: call.agentId } : {}),
  }
}

/**
 * Translate a workbench card into a dsh `PreToolDecision`. `undefined` means the
 * card is still pending (keep hanging). Everything that is not an explicit allow
 * is a deny: fail-closed.
 */
export function decisionFromCard(card: CardLike | undefined): GateDecision | undefined {
  if (!card || card.state === 'pending') return undefined
  switch (card.state) {
    case 'allowed':
    case 'verified':
      return { kind: 'allow' }
    case 'overridden': {
      const constraint = card.appliedConstraint?.trim()
      const explanation = card.verdict?.explanation?.trim()
      const parts = [
        constraint ? `人工翻案：${constraint}` : '人工翻案：原动作被拒绝',
        explanation ? `（判官：${explanation}）` : '',
      ]
      return { kind: 'deny', reason: parts.join('') }
    }
    case 'cancelled':
      return { kind: 'deny', reason: '已被人工叫停（decision-stream fail-closed）' }
    case 'interrupted':
      return { kind: 'deny', reason: '工作台重启，人审 gate 已中断（decision-stream fail-closed）' }
    case 'failed':
      return { kind: 'deny', reason: '工作台记录该动作失败（decision-stream fail-closed）' }
    default:
      return { kind: 'deny', reason: `未知卡片状态 ${String((card as CardLike).state)}（decision-stream fail-closed）` }
  }
}

/** Minimal structural view of a dsh `SessionEvent`. */
export interface SessionEventLike {
  type: string
  seq: number
  time: number
  data?: unknown
}

/** Map a dsh session event to the wire shape `src/adapters/dsh.ts#mapDshEvent` accepts. */
export function toWireEvent(sessionId: string, event: SessionEventLike, agentId = sessionId): DshWireEvent {
  const data = record(event.data)
  return {
    type: event.type,
    sessionId,
    sequence: event.seq,
    at: new Date(event.time).toISOString(),
    agentId,
    ...(typeof data.turn === 'number' ? { turn: data.turn } : {}),
    ...(typeof data.step === 'number' ? { step: data.step } : {}),
    source: 'session.event',
    provider: DSH_PROVIDER,
    version: DSH_TARGET_VERSION,
    payload: event.data,
  }
}

/** Timeline event subset the watcher reads. */
export interface TimelineEventLike {
  id: string
  sequence: number
  type: string
  cardId?: string
  agentId?: string
  message: string
  metadata?: Record<string, unknown>
}

/**
 * The workbench emits one `cancel` event per settled gate with several reasons.
 * Only a human brake ("人工叫停": `POST /cancel`, or decision `{kind:'cancel'}`)
 * should abort the running dsh turn; approval timeouts and our own
 * `POST /cards/:id/cancel` (emitted when dsh aborted first) must not.
 */
export function isHumanStop(event: TimelineEventLike): boolean {
  return event.type === 'cancel' && (event.metadata?.byHuman === true || (/人工叫停/.test(event.message) && event.metadata?.failClosed !== true))
}

/** Text of an `injection` timeline event (forward-only constraint or fork instruction). */
export function injectionText(event: TimelineEventLike): string | undefined {
  if (event.type !== 'injection') return undefined
  const constraint = event.metadata?.constraint
  return typeof constraint === 'string' && constraint.trim() ? constraint.trim() : undefined
}

/** Build the model-facing text for an injected constraint. */
export function injectedConstraintMessage(constraint: string, cardId?: string): string {
  return `[决策流·在案约束] 人工裁决后新增约束，自本步起生效：${constraint}${cardId ? `（来源卡片 ${cardId}）` : ''}`
}

// ---------------------------------------------------------------------------
// Work units (docs/work-unit-design.md §4.2 / §4.5 / §4.7 "dsh 线")
// ---------------------------------------------------------------------------

/** A decision the agent declares through the `declare_decision` tool (§4.2 StructuredDecision). */
export interface StructuredDecision {
  domain: string
  choice: string
  rationale?: string
  specifiedByHuman?: boolean
  extracted?: boolean
}

/** `WorkUnitInput` (§4.2) as posted to `POST /api/sessions/:id/units`. */
export interface WorkUnitInput {
  id?: string
  agentId?: string
  goal: string
  decisions: StructuredDecision[]
  toolCalls: ActionInput[]
  summary?: string
}

export const DECLARE_DECISION_TOOL = 'declare_decision'
export const ASK_USER_TOOL = 'ask_user_question'
export const ASK_USER_DENY_REASON = '请通过决策流卡片与人沟通'

/** Normalize a `declare_decision` call into a StructuredDecision (lower-cased, trimmed; aliasing is server-side). */
export function normalizeDecision(args: unknown): StructuredDecision {
  const a = record(args)
  const domain = String(a.domain ?? '').trim().toLowerCase()
  const choice = String(a.choice ?? '').trim().toLowerCase()
  if (!domain || !choice) throw new Error('declare_decision requires non-empty domain and choice')
  const rationale = typeof a.rationale === 'string' && a.rationale.trim() ? a.rationale.trim() : undefined
  return {
    domain,
    choice,
    ...(rationale ? { rationale } : {}),
    ...(a.specifiedByHuman === true ? { specifiedByHuman: true } : {}),
  }
}

/** Stable unit id for one dsh step: one model response and its tool calls. */
export function unitIdFor(agentId: string | undefined, turn: number | undefined, step: number | undefined): string {
  const agent = (agentId ?? 'agent').replace(/[^A-Za-z0-9_-]/g, '_')
  return `dsh-unit-${agent}-t${turn ?? 0}-s${step ?? 0}`
}

/** Extract the model's stated intent for a step from an `assistant/message` event's content blocks. */
export function stepIntentFromContent(content: unknown, max = 200): string | undefined {
  if (!Array.isArray(content)) return undefined
  const text = content
    .filter((block): block is { type: 'text'; text: string } => !!block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
  return text ? clip(text, max) : undefined
}

/** Names of the tool calls a step's assistant message requested (for the unit summary). */
export function plannedToolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  return content
    .filter((block) => !!block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool-call')
    .map((block) => String((block as { name?: unknown }).name ?? ''))
    .filter(Boolean)
}

export interface StepUnitSource {
  agentId?: string
  turn?: number
  step?: number
  intent?: string
  declarations: StructuredDecision[]
  planned: string[]
  firstCall: ToolCallLike
}

/** Build the unit for a step at its first gated tool call (§4.7: goal = stated intent, else the first tool's description). */
export function toWorkUnit(source: StepUnitSource): WorkUnitInput {
  const goal = source.intent ?? describeToolCall(source.firstCall.name, source.firstCall.arguments)
  const summary = source.planned.length ? `dsh step 计划调用：${source.planned.join(', ')}` : undefined
  return {
    id: unitIdFor(source.agentId, source.turn, source.step),
    ...(source.agentId ? { agentId: source.agentId } : {}),
    goal,
    decisions: source.declarations.map((decision) => ({ ...decision })),
    toolCalls: [toActionInput(source.firstCall)],
    ...(summary ? { summary } : {}),
  }
}

/**
 * Map a unit to an action for workbenches that expose unit metadata on actions.
 */
export function toUnitAction(unit: WorkUnitInput, call: ToolCallLike, options: ToActionOptions = {}): ActionInput {
  const action = toActionInput(call, options)
  return {
    ...action,
    id: unit.id ?? action.id,
    description: unit.goal,
    args: { ...action.args, unitId: unit.id, goal: unit.goal, decisions: unit.decisions, ...(unit.summary ? { summary: unit.summary } : {}) },
  }
}

/** A later tool call of an already-admitted unit: an ordinary action tagged with `unitId`. */
export function toSubCallAction(unitId: string, call: ToolCallLike, options: ToActionOptions = {}): ActionInput {
  const action = toActionInput(call, options)
  return { ...action, args: { ...action.args, unitId } }
}
