/**
 * Decision Stream bridge plugin for DeepSeek Harness 0.1.3-alpha.1 at commit d347e70390.
 *
 * What it does (all inside one dsh process, no dsh source changes):
 *   1. Registers a `tools/pre-execute` waterfall listener. One dsh STEP (one model
 *      response and its tool calls) is one WORK UNIT: at the first gated tool
 *      call of a step it posts the unit to the workbench (`POST /units`, or
 *      `POST /actions` carrying `args.unitId` while that route does not exist),
 *      hangs until the card leaves `pending`, and returns allow / deny(reason).
 *      Later tool calls of the same step flow as sub-calls (`POST /actions` with
 *      `args.unitId`) so the server-side safety net can still block them.
 *   2. Registers the `declare_decision(domain, choice, rationale, specifiedByHuman)`
 *      tool and a system-prompt section ("先申报后动手") so the model declares
 *      design decisions before acting; declarations are buffered per step and
 *      travel with the unit. Undeclared decisions are extracted server-side.
 *   3. Always blocks dsh's built-in `ask_user_question`: a global monotonic
 *      `ctx.tools.guard()` (cannot be overridden by any listener), a pre-execute
 *      deny with reason "请通过决策流卡片与人沟通", and a prompt instruction.
 *      The registry cannot hide a preset-registered tool from the model
 *      (`tools.restrict()` refuses scope-local names — see docs), so removing
 *      the `tool-ask-user` row from the agent preset is documented separately.
 *   4. A human override (`card.appliedConstraint`) is handed to the agent with
 *      `agent.inject()` (lands in the next admitted request); a human brake in
 *      the workbench calls `agent.cancel({ kind: 'user' })`; dsh's own abort
 *      (`exec.signal`) settles the workbench card (POC pitfall #1).
 *   5. dsh session events are mirrored to a local JSONL (and POSTed as adapter
 *      events if the workbench ever exposes `/adapter-events`).
 *
 * Load `./dist/index.js` through the dsh loader's normal plugin configuration;
 * this package deliberately does not depend on a repository-local patch file.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool, type PostToolDecision, type PreToolDecision, type ToolExecution, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  ASK_USER_DENY_REASON,
  ASK_USER_TOOL,
  DECLARE_DECISION_TOOL,
  DSH_TARGET_VERSION,
  classifyTool,
  decisionFromCard,
  injectedConstraintMessage,
  injectionText,
  isHumanStop,
  normalizeDecision,
  plannedToolNames,
  stepIntentFromContent,
  toActionInput,
  toSubCallAction,
  toWireEvent,
  toWorkUnit,
  unitIdFor,
  type ActionInput,
  type GateDecision,
  type StructuredDecision,
  type TimelineEventLike,
  type WorkUnitInput,
} from './mapping.js'
import { WorkbenchClient, WorkbenchError, findCard, type SessionStateLike } from './workbench-client.js'

export const name = 'decision-stream'
export const inject = ['tools', 'agents', 'systemPrompt']

/** Plugin config; every field has an environment override (see {@link resolveConfig}). */
export interface Config {
  /** Workbench origin. Env: DECISION_STREAM_URL. Default http://127.0.0.1:4173 */
  baseUrl?: string
  /** Reuse an existing workbench session. Env: DECISION_STREAM_SESSION. Default: create one on start. */
  sessionId?: string
  /** Mode for a created session. Env: DECISION_STREAM_MODE. Default forward-only. */
  mode?: 'forward-only' | 'rewind-and-fork'
  /** Title for a created session. Env: DECISION_STREAM_TITLE. */
  title?: string
  /** Spec to confirm automatically when the session has none. Env: DECISION_STREAM_SPEC_REQUEST / DECISION_STREAM_SPEC_CONSTRAINTS (JSON array or `|`-separated). */
  spec?: { request: string; constraints: string[] }
  /** Also gate observe-only tools (read/grep/...). Env: DECISION_STREAM_GATE_READS=1. Default false. */
  gateReads?: boolean
  /** What to do when the workbench is unreachable. Env: DECISION_STREAM_ON_UNAVAILABLE. Default deny (fail-closed). */
  onUnavailable?: 'deny' | 'allow'
  /** Poll interval for pending cards. Env: DECISION_STREAM_POLL_MS. Default 400. */
  pollIntervalMs?: number
  /** Directory for local dsh session-event JSONL. Env: DECISION_STREAM_EVENTS_DIR. Default <cwd>/.decision-stream/dsh-events. Set '' to disable. */
  eventsDir?: string
  /** Nest raw tool arguments under args.arguments (default true; see mapping.ts). */
  nestArguments?: boolean
  /** Register `declare_decision` + the "先申报后动手" prompt section (default true). Env: DECISION_STREAM_DECLARE=0 disables. */
  declareDecisions?: boolean
  /** Log sink; defaults to stderr. */
  log?: (line: string) => void
}

export interface ResolvedConfig {
  baseUrl: string
  sessionId?: string
  mode: 'forward-only' | 'rewind-and-fork'
  title: string
  spec?: { request: string; constraints: string[] }
  gateReads: boolean
  onUnavailable: 'deny' | 'allow'
  pollIntervalMs: number
  eventsDir: string
  nestArguments: boolean
  declareDecisions: boolean
  log: (line: string) => void
}

function parseConstraints(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[')) {
    try { const parsed = JSON.parse(trimmed); if (Array.isArray(parsed)) return parsed.map(String) } catch { /* fall through */ }
  }
  return trimmed.split('|').map((item) => item.trim()).filter(Boolean)
}

const flag = (env: string | undefined, fallback: boolean): boolean => (env === undefined ? fallback : env !== '0' && env.toLowerCase() !== 'false')

export function resolveConfig(config: Config = {}, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const request = env.DECISION_STREAM_SPEC_REQUEST ?? config.spec?.request
  const constraints = parseConstraints(env.DECISION_STREAM_SPEC_CONSTRAINTS) ?? config.spec?.constraints
  const spec = request !== undefined || constraints !== undefined
    ? { request: request ?? 'dsh 会话', constraints: constraints ?? [] }
    : undefined
  const modeEnv = env.DECISION_STREAM_MODE
  return {
    baseUrl: env.DECISION_STREAM_URL ?? config.baseUrl ?? 'http://127.0.0.1:4173',
    sessionId: env.DECISION_STREAM_SESSION ?? config.sessionId,
    mode: modeEnv === 'rewind-and-fork' || modeEnv === 'forward-only' ? modeEnv : config.mode ?? 'forward-only',
    title: env.DECISION_STREAM_TITLE ?? config.title ?? `dsh ${DSH_TARGET_VERSION} · ${new Date().toISOString()}`,
    spec,
    gateReads: flag(env.DECISION_STREAM_GATE_READS, config.gateReads ?? false),
    onUnavailable: env.DECISION_STREAM_ON_UNAVAILABLE === 'allow' ? 'allow' : env.DECISION_STREAM_ON_UNAVAILABLE === 'deny' ? 'deny' : config.onUnavailable ?? 'deny',
    pollIntervalMs: Number(env.DECISION_STREAM_POLL_MS ?? config.pollIntervalMs ?? 400) || 400,
    eventsDir: env.DECISION_STREAM_EVENTS_DIR ?? config.eventsDir ?? join(process.cwd(), '.decision-stream', 'dsh-events'),
    nestArguments: config.nestArguments ?? true,
    declareDecisions: flag(env.DECISION_STREAM_DECLARE, config.declareDecisions ?? true),
    log: config.log ?? ((line: string) => { process.stderr.write(`[decision-stream] ${line}\n`) }),
  }
}

/** The "先申报后动手" instruction (system-prompt section). */
export const DECLARE_PROMPT = [
  '## 决策流：先申报，后动手',
  '你在一个受人监督的决策流中工作。每一步（一次回复里的全部工具调用）会作为一个「工作单元」交给人审核。',
  `规则：在做出任何设计/技术选型决策（storage、cache、auth、frontend-framework、language、api-style、testing、deploy、external-side-effect 等）之后、在动手写文件或运行命令之前，先在同一次回复里调用 \`${DECLARE_DECISION_TOOL}\` 申报该决策（domain、choice、rationale；若是人明确指定的，specifiedByHuman=true），再调用动作工具。`,
  '未申报的决策会被系统从工具调用中推断出来并标为低置信度；申报与实际不符会被记录为漂移。',
  '如果一个工具调用被拒绝并返回「人工翻案」理由，请按理由改道，不要重试同一动作。',
  `不要使用 \`${ASK_USER_TOOL}\`：所有与人的沟通只能通过决策流卡片进行（该工具会被拒绝，理由「${ASK_USER_DENY_REASON}」）。`,
].join('\n')

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = (): void => { clearTimeout(timer); resolve() }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Per-agent view of the current dsh step = the current work unit. */
interface StepState {
  turn?: number
  step?: number
  /** Model's stated intent (text blocks of the step's assistant message). */
  intent?: string
  /** Tool names the step's assistant message requested. */
  planned: string[]
  /** `declare_decision` calls seen in this step (recorded at pre-execute so they precede the first action tool). */
  declarations: StructuredDecision[]
  unit?: {
    id: string
    /** Which route carried the unit card. */
    route: 'units' | 'actions'
    /** Resolves once the unit card left pending; later calls of the step await it. */
    outcome: Promise<GateDecision>
    /** The first tool's callId when it doubled as the unit card (`actions` route). */
    firstCallId?: string
  }
}

/** Public handle so tests (and an in-process host) can inspect the bridge. */
export class DecisionStreamBridge {
  readonly config: ResolvedConfig
  readonly client: WorkbenchClient
  /** Cards this bridge already injected a constraint for (dedupe against the timeline watcher). */
  readonly injectedCards = new Set<string>()
  /** Agents seen through the gate, by session id. */
  readonly agents = new Map<string, Agent>()
  private readonly seenTimeline = new Set<string>()
  private lastTimelineSequence = 0
  private sessionPromise?: Promise<string>
  private watcher?: ReturnType<typeof setInterval>
  private adapterEventRoute: 'unknown' | 'present' | 'absent' = 'unknown'
  private wireSequence = 0
  private readonly steps = new Map<string, StepState>()
  private stopped = false

  constructor(private readonly ctx: Context, config: Config = {}) {
    this.config = resolveConfig(config)
    this.client = new WorkbenchClient(this.config.baseUrl)
  }

  get sessionId(): string | undefined { return this.resolvedSessionId }
  private resolvedSessionId?: string

  start(): void {
    const { ctx } = this
    ctx.on('tools/pre-execute', (exec, next) => this.preExecute(exec, next))
    ctx.on('tools/post-execute', (exec, result, next) => this.postExecute(exec, result, next))
    ctx.on('tools/result', (exec, result) => { this.onToolResult(exec, result); return undefined })
    ctx.on('session/created', (session) => this.onSessionCreated(session))
    ctx.on('session/disposed', (session) => this.onSessionDisposed(session))
    ctx.on('session/event', (session, event) => this.onSessionEvent(session, event))
    // Unconditional monotonic guard: no listener can force-allow this tool.
    ctx.tools.guard((exec) => (exec.name === ASK_USER_TOOL ? ASK_USER_DENY_REASON : undefined))
    if (this.config.declareDecisions) {
      ctx.tools.register(defineTool({
        name: DECLARE_DECISION_TOOL,
        description: '申报一个设计/技术选型决策（先申报后动手）。在写文件或运行命令之前、在同一次回复里调用。'
          + 'domain 是决策域（storage/cache/auth/frontend-framework/language/api-style/testing/deploy/external-side-effect 或其他），'
          + 'choice 是规范化选择（如 sqlite/postgres/jwt/session/memory-cache），rationale 是一句话理由；'
          + '仅当人明确指定该选择时 specifiedByHuman=true。',
        parameters: {
          domain: { type: 'string', required: true, description: '决策域，小写，如 storage / cache / auth。' },
          choice: { type: 'string', required: true, description: '选择，小写，如 sqlite / postgres / jwt。' },
          rationale: { type: 'string', description: '一句话理由（进卡片文案）。' },
          specifiedByHuman: { type: 'boolean', description: '人是否明确指定了这个选择。' },
        },
        output: {
          schema: { type: 'object', additionalProperties: true, properties: { recorded: { type: 'boolean', required: true }, domain: { type: 'string', required: true }, choice: { type: 'string', required: true } } },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        isConcurrencySafe: () => true,
        async execute(args) {
          const decision = normalizeDecision(args)
          return { recorded: true, domain: decision.domain, choice: decision.choice }
        },
      }))
      ctx.systemPrompt.section({ name: 'decision-stream:declare', order: 900, text: DECLARE_PROMPT })
    } else {
      ctx.systemPrompt.section({ name: 'decision-stream:ask-user', order: 900, text: `不要使用 \`${ASK_USER_TOOL}\`：所有与人的沟通只能通过决策流卡片进行。` })
    }
    this.watcher = setInterval(() => { void this.watchTimeline() }, Math.max(this.config.pollIntervalMs * 2, 500))
    this.watcher.unref?.()
    void this.ensureSession().catch((error: unknown) => this.config.log(`workbench unavailable at start: ${describe(error)} (gate is fail-${this.config.onUnavailable === 'deny' ? 'closed' : 'open'})`))
  }

  stop(): void {
    this.stopped = true
    if (this.watcher) clearInterval(this.watcher)
  }

  /** Create or reuse the workbench session (memoized; retried on failure). */
  ensureSession(): Promise<string> {
    if (!this.sessionPromise) {
      this.sessionPromise = (async () => {
        const configured = this.config.sessionId
        if (configured) {
          const state = await this.client.getState(configured)
          if (state.endedAt) throw new Error(`workbench session ${configured} already ended`)
          this.resolvedSessionId = state.sessionId
          this.config.log(`using workbench session ${state.sessionId} (${state.mode}) at ${this.config.baseUrl}/`)
          return state.sessionId
        }
        const state = await this.client.createSession(this.config.mode, this.config.title)
        this.resolvedSessionId = state.sessionId
        this.config.log(`created workbench session ${state.sessionId} (${state.mode}) — open ${this.config.baseUrl}/ and select it`)
        return state.sessionId
      })().catch((error: unknown) => { this.sessionPromise = undefined; throw error })
    }
    return this.sessionPromise
  }

  /** Make sure the session has a confirmed spec: auto-confirm the configured one, else wait for the human. */
  private async ensureSpec(sessionId: string, signal: AbortSignal): Promise<void> {
    let announced = false
    for (;;) {
      const state = await this.client.getState(sessionId, signal)
      if (state.spec?.confirmed) return
      if (this.config.spec) {
        try {
          await this.client.confirmSpec(sessionId, { id: `dsh-spec-${Date.now()}`, request: this.config.spec.request, constraints: this.config.spec.constraints, confirmed: true })
          this.config.log(`confirmed spec from config: ${this.config.spec.request} [${this.config.spec.constraints.join(' | ')}]`)
          return
        } catch (error) {
          if (!(error instanceof WorkbenchError && error.status === 409)) throw error
        }
      }
      if (!announced) { this.config.log(`session ${sessionId} has no confirmed spec — tool call is waiting for the human to confirm one in the workbench`); announced = true }
      if (signal.aborted) throw new Error('aborted while waiting for spec confirmation')
      await sleep(this.config.pollIntervalMs, signal)
    }
  }

  private stepFor(agentId: string): StepState {
    let state = this.steps.get(agentId)
    if (!state) { state = { planned: [], declarations: [] }; this.steps.set(agentId, state) }
    return state
  }

  private async preExecute(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
    const agent = exec.agent
    if (agent) this.agents.set(agent.id, agent)
    if (exec.name === ASK_USER_TOOL) {
      this.config.log(`denied ${ASK_USER_TOOL} (${exec.callId}): ${ASK_USER_DENY_REASON}`)
      return { kind: 'deny', reason: ASK_USER_DENY_REASON }
    }
    if (exec.name === DECLARE_DECISION_TOOL) {
      // Pre-execute runs in submission order, so a declaration made before an action tool in the
      // same response is buffered here before that action's gate builds the unit.
      try {
        const decision = normalizeDecision(exec.arguments)
        if (agent) this.stepFor(agent.id).declarations.push(decision)
        this.config.log(`declared decision ${decision.domain}=${decision.choice}${decision.specifiedByHuman ? ' (specified by human)' : ''}`)
      } catch (error) {
        return { kind: 'deny', reason: describe(error) }
      }
      return next()
    }
    const { kind, observeOnly } = classifyTool(exec.name, exec.arguments)
    if (observeOnly && !this.config.gateReads) {
      this.config.log(`observe-only ${exec.name} (${kind}) → allow without a card`)
      return next()
    }
    let decision: GateDecision
    try {
      decision = await this.gate(exec)
    } catch (error) {
      if (exec.signal.aborted) return { kind: 'deny', reason: '工具调用已被 dsh 取消（decision-stream）' }
      const reason = `工作台不可用：${describe(error)}`
      this.config.log(`${reason} → ${this.config.onUnavailable}`)
      if (this.config.onUnavailable === 'allow') return next()
      return { kind: 'deny', reason: `${reason}（decision-stream fail-closed）` }
    }
    if (decision.kind === 'allow') {
      this.config.log(`approved ${exec.name} (${exec.callId}); outcome remains pending until tools/result`)
      return next()
    }
    return decision
  }

  /**
   * The gate. First gated call of a step → post the WORK UNIT and hang; later calls
   * of the same step → wait for the unit outcome, then flow as sub-calls.
   */
  async gate(exec: ToolExecution): Promise<GateDecision> {
    const sessionId = await this.ensureSession()
    const agentId = exec.agent?.id
    const step = agentId ? this.stepFor(agentId) : { planned: [], declarations: [] } satisfies StepState
    const call = { callId: exec.callId, name: exec.name, arguments: exec.arguments, agentId, turn: step.turn, step: step.step }
    if (!step.unit) {
      const unit = toWorkUnit({ agentId, turn: step.turn, step: step.step, intent: step.intent, declarations: step.declarations, planned: step.planned, firstCall: call })
      const outcome = this.postUnitAndWait(sessionId, unit, call, exec)
      step.unit = { id: unit.id!, route: 'units', outcome, firstCallId: exec.callId }
      const decision = await outcome
      if (decision.kind === 'deny') return decision
      return decision
    }
    const unitDecision = await step.unit.outcome
    if (unitDecision.kind === 'deny') return { kind: 'deny', reason: `本工作单元已被拒绝，单元整体不执行：${unitDecision.reason}` }
    return this.subCall(sessionId, step.unit.id, call, exec)
  }

   /** Post the unit and wait for its card. Missing `/units` is surfaced as a gate failure. */
  private async postUnitAndWait(sessionId: string, unit: WorkUnitInput, firstCall: { callId: string; name: string; arguments: unknown; agentId?: string; turn?: number; step?: number }, exec: ToolExecution): Promise<GateDecision> {
    const cardId = unit.id!
    let state: SessionStateLike | undefined
    for (;;) {
      if (exec.signal.aborted) return this.abortedByDsh(sessionId, cardId, false)
      await this.ensureSpec(sessionId, exec.signal)
      try {
        state = await this.client.postUnit(sessionId, unit, exec.signal)
        break
      } catch (error) {
        if (error instanceof WorkbenchError && error.status === 409 && /spec/i.test(error.message)) continue
        throw error
      }
    }
    this.config.log(`unit ${cardId} posted (${unit.decisions.length} declared decision(s); goal: ${unit.goal}) — waiting for the workbench`)
    return this.waitForCard(sessionId, cardId, state, exec)
  }

  /** A later tool call of an admitted unit: post it with `args.unitId`, wait for its own card (safety net). */
  private async subCall(sessionId: string, unitId: string, call: { callId: string; name: string; arguments: unknown; agentId?: string; turn?: number; step?: number }, exec: ToolExecution): Promise<GateDecision> {
    const action = toSubCallAction(unitId, call, { nestArguments: this.config.nestArguments })
    if (exec.signal.aborted) return this.abortedByDsh(sessionId, action.id!, false)
    const state = await this.client.postAction(sessionId, action, exec.signal)
    this.config.log(`sub-call ${action.id} of ${unitId} posted for ${exec.name} (${action.kind})`)
    return this.waitForCard(sessionId, action.id!, state, exec)
  }

  private async waitForCard(sessionId: string, cardId: string, initial: SessionStateLike | undefined, exec: ToolExecution): Promise<GateDecision> {
    let state = initial
    let card = findCard(state, cardId)
    let decision = decisionFromCard(card)
    while (!decision) {
      if (exec.signal.aborted) return this.abortedByDsh(sessionId, cardId, true)
      await sleep(this.config.pollIntervalMs, exec.signal)
      if (exec.signal.aborted) return this.abortedByDsh(sessionId, cardId, true)
      state = await this.client.getState(sessionId, exec.signal)
      card = findCard(state, cardId)
      decision = decisionFromCard(card)
    }
    this.config.log(`card ${cardId} → ${card!.state}${decision.kind === 'deny' ? `: ${decision.reason}` : ''}`)
    if (card!.state === 'overridden' && card!.appliedConstraint && exec.agent) {
      this.injectConstraint(exec.agent, card!.appliedConstraint, cardId)
      this.injectedCards.add(cardId)
    }
    if (card!.state === 'cancelled' && exec.agent) {
      const events = state?.timeline.filter((event) => event.cardId === cardId && event.type === 'cancel') ?? []
      if (events.some(isHumanStop)) {
        this.config.log(`human brake on ${cardId} → agent.cancel({ kind: 'user' }) for ${exec.agent.id}`)
        this.cancelAgent(exec.agent, `human brake on ${cardId}`)
      }
    }
    return decision
  }

  /** dsh aborted (agent.cancel / turn abort) while we were hanging: settle the workbench card and deny. */
  private async abortedByDsh(sessionId: string, cardId: string, posted: boolean): Promise<GateDecision> {
    if (posted) await this.client.cancelCard(sessionId, cardId).catch((error: unknown) => this.config.log(`cancelCard ${cardId} failed: ${describe(error)}`))
    this.config.log(`card ${cardId} abandoned: dsh aborted the call (exec.signal)`)
    return { kind: 'deny', reason: '工具调用已被 dsh 取消（agent.cancel / turn abort）' }
  }

  injectConstraint(agent: Agent, constraint: string, cardId?: string): void {
    const text = injectedConstraintMessage(constraint, cardId)
    agent.inject(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: name } }))
    this.emitBridgeEvent(agent.id, 'agent.inject', { message: text, cardId })
    this.config.log(`agent.inject → ${agent.id}: ${constraint}`)
  }

  private cancelAgent(agent: Agent, reason: string): void {
    agent.cancel({ kind: 'user' })
    this.emitBridgeEvent(agent.id, 'agent.cancel', { reason })
  }

  /** Poll the workbench timeline for post-hoc injections and human stops that did not come through a gate. */
  private async watchTimeline(): Promise<void> {
    if (this.stopped || !this.resolvedSessionId || this.agents.size === 0) return
    let events: TimelineEventLike[]
    try {
      events = await this.client.timeline(this.resolvedSessionId, { since: this.lastTimelineSequence })
    } catch (error) {
      this.config.log(`timeline poll failed: ${describe(error)}`)
      return
    }
    for (const event of events) {
      this.lastTimelineSequence = Math.max(this.lastTimelineSequence, event.sequence)
      if (this.seenTimeline.has(event.id)) continue
      this.seenTimeline.add(event.id)
      const targets = this.targetsFor(event.agentId)
      const constraint = injectionText(event)
      if (constraint) {
        if (event.cardId && this.injectedCards.delete(event.cardId)) continue // already injected by the gate
        for (const agent of targets) this.injectConstraint(agent, constraint, event.cardId)
        continue
      }
      if (isHumanStop(event)) {
        for (const agent of targets) {
          if (agent.status === 'running') { this.config.log(`human brake (timeline) → agent.cancel for ${agent.id}`); this.cancelAgent(agent, 'human brake from workbench timeline') }
        }
      }
    }
  }

  private targetsFor(agentId: string | undefined): Agent[] {
    if (agentId) {
      const live = this.ctx.agents.get(SessionId(agentId)) ?? this.agents.get(agentId)
      if (live) return [live]
    }
    return [...this.agents.values()]
  }

  private onSessionEvent(session: Session, event: SessionEvent): void {
    const agentId = session.id
    if (event.type === 'turn/start') {
      this.steps.set(agentId, { turn: event.data.turn, planned: [], declarations: [] })
    } else if (event.type === 'step/start') {
      // New step = new work unit.
      this.steps.set(agentId, { turn: event.data.turn, step: event.data.step, planned: [], declarations: [] })
    } else if (event.type === 'assistant/message') {
      const step = this.stepFor(agentId)
      step.intent = stepIntentFromContent(event.data.message.content) ?? step.intent
      step.planned = plannedToolNames(event.data.message.content)
    } else if (event.type === 'step/end') {
      const step = this.steps.get(agentId)
      // A step that declared decisions but ran no gated tool is a pure-decision unit (§4.7): post it, no hang.
      if (step && !step.unit && step.declarations.length > 0 && this.resolvedSessionId) {
        const unit: WorkUnitInput = { id: unitIdFor(agentId, step.turn, step.step), agentId, goal: step.intent ?? '（纯决策单元）', decisions: [...step.declarations], toolCalls: [] }
        void this.client.postUnit(this.resolvedSessionId, unit).catch((error: unknown) => this.config.log(`pure-decision unit post failed: ${describe(error)}`))
      }
    }
    this.publishWireEvent(toWireEvent(agentId, event))
  }

  private onSessionCreated(session: Session): void {
    const parentSessionId = session.header.parentSession
    if (parentSessionId === undefined) {
      this.emitBridgeEvent(session.id, 'session/start', { header: session.header }, 'session.lifecycle')
      return
    }
    const inherited = session.snapshotEvents(undefined, session.inheritedEventCount)
    const turnBoundary = inherited.filter((event) => event.type === 'turn/end').at(-1)
    this.emitBridgeEvent(session.id, 'session/fork', {
      parentSessionId,
      inheritedEventCount: session.inheritedEventCount,
      ...(turnBoundary?.type === 'turn/end' ? { turnBoundary: turnBoundary.data.turn } : {}),
    }, 'session.lifecycle')
  }

  private onSessionDisposed(session: Session): void {
    this.emitBridgeEvent(session.id, 'session/end', {}, 'session.lifecycle')
  }

  private emitBridgeEvent(sessionId: string, type: string, payload: unknown, source: 'session.lifecycle' | 'decision-stream' = 'decision-stream'): void {
    this.publishWireEvent({
      type,
      sessionId,
      sequence: Date.now(),
      at: new Date().toISOString(),
      agentId: sessionId,
      source,
      provider: 'deepseek-harness',
      version: DSH_TARGET_VERSION,
      payload,
    })
  }

  private publishWireEvent(wire: ReturnType<typeof toWireEvent>): void {
    const transportWire = {
      ...wire,
      ...(wire.source === 'session.event' ? { sourceSequence: wire.sequence } : {}),
      sequence: ++this.wireSequence,
    }
    const agentId = transportWire.agentId ?? transportWire.sessionId
    if (this.config.eventsDir) {
      try {
        mkdirSync(this.config.eventsDir, { recursive: true })
        appendFileSync(join(this.config.eventsDir, `${agentId}.jsonl`), `${JSON.stringify(transportWire)}\n`)
      } catch (error) { this.config.log(`event log write failed: ${describe(error)}`) }
    }
    if (this.adapterEventRoute !== 'absent' && this.resolvedSessionId) {
      void this.client.postAdapterEvent(this.resolvedSessionId, transportWire).then((present) => {
        if (!present && this.adapterEventRoute !== 'absent') { this.adapterEventRoute = 'absent'; this.config.log('workbench has no adapter-events route; dsh session events stay in the local JSONL only') }
        else if (present) this.adapterEventRoute = 'present'
      }).catch(() => { /* best effort */ })
    }
  }

  /** Observe post-execute without modifying dsh's authoritative result. */
  private async postExecute(exec: ToolExecution, _result: ToolExecutionResult, next: () => Promise<PostToolDecision>): Promise<PostToolDecision> {
    this.config.log(`post-execute ${exec.name} (${exec.callId})`)
    return next()
  }

  /** Persist the final result only after dsh has settled the tool call. */
  private onToolResult(exec: ToolExecution, result: ToolExecutionResult): void {
    const agentId = exec.agent?.id
    const unit = agentId ? this.steps.get(agentId)?.unit : undefined
    if (!unit || !this.resolvedSessionId) return
    const args = exec.arguments && typeof exec.arguments === 'object' && !Array.isArray(exec.arguments)
      ? exec.arguments as Record<string, unknown>
      : {}
    const payload = {
      unitId: unit.id, callId: String(exec.callId), tool: exec.name, ok: !result.isError,
      ...(result.isError ? { error: result.error?.message ?? 'tool execution failed' } : { output: result.value }),
      ...(result.meta !== undefined ? { evidence: result.meta } : {}),
      ...(typeof args.externalSideEffect === 'boolean' ? { externalSideEffect: args.externalSideEffect } : {}),
    }
    void this.client.postToolResult(this.resolvedSessionId, payload).then((present) => {
      if (!present) this.config.log(`tool-result ${exec.callId} not persisted: workbench has no /adapter-events route`)
    }).catch((error: unknown) => this.config.log(`tool-result ${exec.callId} write failed: ${describe(error)}`))
  }

  /** Map one raw tool call (test/diagnostic helper). */
  mapCall(call: { callId: string; name: string; arguments: unknown; agentId?: string }): ActionInput {
    return toActionInput(call, { nestArguments: this.config.nestArguments })
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Cordis function-form plugin entry: `apply(ctx, config)`. */
export function apply(ctx: Context, config: Config = {}): void {
  const bridge = new DecisionStreamBridge(ctx, config)
  ctx.effect(() => { bridge.start(); return () => bridge.stop() })
}
