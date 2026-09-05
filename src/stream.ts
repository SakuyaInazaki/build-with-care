import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { DeterministicJudge, DeterministicRecorder, type DecisionJudge, type DecisionRecorder } from './judge.js'
import type {
  ActionInput, ActionResult, ActionIdentity, AgentExecutor, AgentReport, Branch, CardState, ColorCounts, ConfirmedSpec, CorrectionMode,
  CorrectionRecord, DecisionCard, ExecutorInput, ExecutorResult, EventPersistence, FailureKind, HumanDecision, PostHocDecision, SessionReport,
  TimelineEvent, TimelineEventSource, TimelineEventType, VerificationEvidence, WorkspaceSnapshotAdapter,
} from './types.js'
import { extractDecisions, isConstraintConflict, matchDecisions, structureConstraint, structureSpecConstraints, verdictForUnit } from './work-unit.js'
import type { UnitToolCall, WorkUnitInput } from './types.js'

const runFile = promisify(execFile)

export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000

/** `DECISION_STREAM_APPROVAL_TIMEOUT_MS` overrides the 10 minute fail-closed default. */
export function approvalTimeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.DECISION_STREAM_APPROVAL_TIMEOUT_MS)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_APPROVAL_TIMEOUT_MS
}

/** Errors the HTTP layer can map 1:1 onto a status and error code. */
export class DecisionStreamError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'DecisionStreamError'
  }
}

type Gate = {
  card: DecisionCard
  signal: AbortSignal
  resolve: (result: ActionResult) => void
  timer?: ReturnType<typeof setTimeout>
  decision?: HumanDecision
  resume?: () => Promise<ActionResult>
}
type ExecuteOptions = { signal?: AbortSignal; timeoutMs?: number; agentSignal?: AbortSignal }
type EventListener = (event: TimelineEvent) => void

export class LocalAgentExecutor implements AgentExecutor {
  constructor(private readonly workspaceRoot = process.cwd()) {}

  /** The workspace is created lazily so an unused session never leaves a directory behind. */
  private root(): string {
    const absolute = resolve(this.workspaceRoot)
    mkdirSync(absolute, { recursive: true })
    return realpathSync(absolute)
  }

  private safePath(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error('path is required')
    const root = this.root()
    const path = resolve(root, value)
    let checked = path
    if (existsSync(path)) checked = realpathSync(path)
    else {
      let parent = dirname(path)
      while (parent !== root && !existsSync(parent)) parent = dirname(parent)
      checked = resolve(realpathSync(parent), path.slice(parent.length + 1))
    }
    if (checked !== root && !checked.startsWith(`${root}/`)) throw new Error('path is outside workspace')
    return path
  }

  async execute({ action, signal }: ExecutorInput): Promise<ExecutorResult> {
    if (signal.aborted) return { ok: false, error: 'executor aborted' }
    try {
      if (action.kind === 'write' && typeof action.args.path === 'string') {
        const path = this.safePath(action.args.path)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, String(action.args.content ?? ''), 'utf8')
        return { ok: true, output: { path }, externalSideEffect: false }
      }
      if (action.kind === 'read') return { ok: true, output: await readFile(this.safePath(action.args.path), 'utf8') }
      if (action.kind === 'validate') {
        const target = action.args.target
        if (typeof target !== 'string' || !target.trim()) return { ok: false, error: 'controlled validation requires a target' }
        try {
          const targetPath = this.safePath(target)
          if (!existsSync(targetPath)) return { ok: false, error: `验证失败：目标不存在 ${target}` }
          return { ok: true, output: { check: action.description, target }, verification: { kind: 'check', detail: `受控检查通过：${target}`, passed: true }, externalSideEffect: false }
        } catch (error) {
          return { ok: false, error: `验证失败：${error instanceof Error ? error.message : String(error)}` }
        }
      }
      if (action.kind === 'command' && typeof action.args.command === 'string') {
        const command = action.args.command.trim()
        const match = /^(?:node --version|npm (?:--version|test|run (?:typecheck|build)))$/.exec(
          command,
        )
        if (!match || /[;&|`$<>]/.test(command)) return { ok: false, error: 'command is not in the demo-safe allowlist' }
        const [executable, ...args] = command.split(/\s+/)
        const result = await runFile(executable!, args, { cwd: this.root(), signal })
        return { ok: true, output: result.stdout, externalSideEffect: Boolean(action.args.external) }
      }
      return { ok: true, output: { executed: action.tool }, externalSideEffect: Boolean(action.args.external) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

class NoopWorkspaceSnapshotAdapter implements WorkspaceSnapshotAdapter {
  snapshot(identity: ActionIdentity): string { return `logical-snapshot:${identity.branchId}:${identity.turn}` }
  fork(): void { /* Physical files require an injected adapter, never implicit rollback. */ }
}

export interface DecisionStreamOptions {
  mode?: CorrectionMode
  title?: string
  judge?: DecisionJudge
  recorder?: DecisionRecorder
  executor?: AgentExecutor
  workspaceSnapshots?: WorkspaceSnapshotAdapter
  sessionId?: string
  humanInstruction?: string
  approvalTimeoutMs?: number
  persistence?: EventPersistence
  restoredEvents?: TimelineEvent[]
}

const MAX_RUNTIME_ATTEMPTS = 3

export class DecisionStream {
  readonly cards: DecisionCard[] = []
  readonly sessionId: string
  readonly mode: CorrectionMode
  readonly approvalTimeoutMs: number

  private readonly timeline: TimelineEvent[] = []
  private readonly gates = new Map<string, Gate>()
  private readonly branches = new Map<string, Branch>()
  private readonly agentControllers = new Map<string, AbortController>()
  private readonly turnControllers = new Map<number, AbortController>()
  private readonly agentIds = new Set<string>()
  private readonly completedTurns = new Set<number>()
  private readonly verdicts = new Map<string, string>()
  private readonly queuedDecisions = new Map<string, HumanDecision>()
  private readonly units = new Map<string, DecisionCard>()
  private readonly listeners = new Set<EventListener>()
  private readonly judge: DecisionJudge
  private readonly recorder: DecisionRecorder
  private readonly executor: AgentExecutor
  private readonly workspace: WorkspaceSnapshotAdapter
  private readonly persistence?: EventPersistence
  private controller = new AbortController()
  private counter = 0
  private sequence = 0
  private turn = 0
  private step = 0
  private activeBranch = 'main'
  private activeSpec?: ConfirmedSpec
  private humanInstruction?: string
  private lastAdjudication?: string
  private explicitTitle?: string
  private startedAt = new Date().toISOString()
  private finishedAt?: string
  private sessionCancelRecorded = false

  constructor(judgeOrOptions: DecisionJudge | DecisionStreamOptions = {}) {
    const value = judgeOrOptions as DecisionStreamOptions & DecisionJudge
    const options: DecisionStreamOptions = typeof judgeOrOptions === 'object' && typeof value.judge !== 'function' ? value : { judge: judgeOrOptions as DecisionJudge }
    const restoredMode = options.restoredEvents?.find((event) => event.type === 'session-start')?.metadata?.mode
    this.mode = restoredMode === 'rewind-and-fork' || restoredMode === 'forward-only' ? restoredMode : options.mode ?? 'forward-only'
    this.judge = options.judge ?? new DeterministicJudge()
    this.recorder = options.recorder ?? new DeterministicRecorder()
    this.executor = options.executor ?? new LocalAgentExecutor()
    this.workspace = options.workspaceSnapshots ?? new NoopWorkspaceSnapshotAdapter()
    this.persistence = options.persistence
    this.sessionId = options.sessionId ?? `session-${Date.now()}`
    this.humanInstruction = options.humanInstruction
    this.explicitTitle = options.title?.trim() || undefined
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? approvalTimeoutFromEnv()
    this.branches.set('main', { id: 'main', active: true, createdAt: this.startedAt })
    if (options.restoredEvents?.length) this.restore(options.restoredEvents)
    else this.addEvent('session-start', `会话开始，纠偏模式：${this.mode}`, undefined, undefined, undefined, undefined, { mode: this.mode, title: this.explicitTitle })
  }

  // ---------------------------------------------------------------------------
  // Session-level accessors
  // ---------------------------------------------------------------------------

  get title(): string { return this.explicitTitle ?? this.activeSpec?.request ?? '未命名会话' }
  get createdAt(): string { return this.startedAt }
  get endedAt(): string | undefined { return this.finishedAt }
  get ended(): boolean { return this.finishedAt !== undefined }
  get spec(): ConfirmedSpec | undefined { return this.activeSpec && { ...this.activeSpec, constraints: [...this.activeSpec.constraints] } }
  get events(): readonly TimelineEvent[] { return this.timeline.map((event) => ({ ...event, metadata: event.metadata && { ...event.metadata } })) }
  get signal(): AbortSignal { return this.controller.signal }
  get branchId(): string { return this.activeBranch }
  get branchList(): readonly Branch[] { return [...this.branches.values()].map((branch) => ({ ...branch })) }
  get agents(): string[] { return [...this.agentIds] }
  get judgeName(): string { return this.judge.name ?? 'custom' }
  get recorderName(): string { return this.recorder.name ?? 'custom' }

  /** Fires for every appended event, including those written during restore recovery. */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  confirmSpec(spec: ConfirmedSpec): void {
    this.assertActive()
    if (!spec.confirmed) throw new DecisionStreamError(400, 'spec_unconfirmed', 'spec must be confirmed before execution')
    if (this.activeSpec) throw new DecisionStreamError(409, 'spec_confirmed', 'spec is already confirmed for this session')
    this.activeSpec = { ...spec, constraints: [...spec.constraints], structuredConstraints: spec.structuredConstraints?.map((item) => ({ ...item, values: [...item.values] })) ?? structureSpecConstraints(spec) }
    this.addEvent('human-command', `已确认 spec：${spec.request}`, undefined, undefined, undefined, undefined, { spec: this.activeSpec }, 'human')
  }

  setHumanInstruction(instruction: string): void {
    this.humanInstruction = instruction
    this.addEvent('human-command', instruction, undefined, undefined, undefined, undefined, undefined, 'human')
  }

  registerAgent(agentId: string): void {
    if (this.agentIds.has(agentId)) return
    this.agentIds.add(agentId)
    this.agentControllers.set(agentId, new AbortController())
    this.addEvent('agent-registered', `Agent ${agentId} 已接入`, undefined, agentId)
  }

  /** Runners and adapters append their own narrative here; it never changes card state. */
  recordRunnerEvent(message: string, metadata?: Record<string, unknown>, agentId?: string): void {
    this.addEvent('runner', message, undefined, agentId, undefined, undefined, metadata, 'runner')
  }

  private assertActive(): void {
    if (this.finishedAt) throw new DecisionStreamError(409, 'session_ended', `session ${this.sessionId} has ended`)
  }

  // ---------------------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------------------

  async execute(action: ActionInput, options: ExecuteOptions = {}): Promise<ActionResult> {
    this.assertActive()
    if (!this.activeSpec) throw new DecisionStreamError(409, 'spec_required', 'confirm a spec before executing actions')
    if (action.id && this.cards.some((card) => card.id === action.id)) throw new DecisionStreamError(409, 'duplicate_card', `duplicate card id: ${action.id}`)
    const agentId = action.agentId ?? 'demo-agent'
    this.registerAgent(agentId)
    const turn = ++this.turn
    const step = ++this.step
    const identity: ActionIdentity = { sessionId: this.sessionId, branchId: this.activeBranch, agentId, turn, step }
    const turnController = new AbortController()
    this.turnControllers.set(turn, turnController)
    this.addEvent('turn-start', `第 ${turn} 轮开始`, undefined, agentId, turn, step)
    this.addEvent('step-start', `第 ${step} 步开始`, undefined, agentId, turn, step)
    this.addEvent('agent-action', `Agent 准备${action.description}`, undefined, agentId, turn, step, { action: structuredClone(action) }, 'agent')

    const constraints = [...this.activeSpec.constraints]
    const assessment = await this.recorder.assess({ ...identity, humanInstruction: this.humanInstruction, constraints, lastAdjudication: this.lastAdjudication, action })
    const modelVerdict = await this.judge.judge({ spec: this.activeSpec, action })
    const policyVerdict = new DeterministicJudge().judge({ spec: this.activeSpec, action })
    // A model may add risk or explanation, but it cannot downgrade a deterministic red floor.
    const verdict = policyVerdict.kind === 'red' && modelVerdict.kind !== 'red'
      ? { ...policyVerdict, explanation: `${policyVerdict.explanation}${modelVerdict.explanation ? `；模型补充：${modelVerdict.explanation}` : ''}` }
      : modelVerdict
    const cardId = action.id ?? this.nextCardId()
    if (this.cards.some((card) => card.id === cardId)) throw new DecisionStreamError(409, 'duplicate_card', `duplicate card id: ${cardId}`)

    const card: DecisionCard = {
      ...identity,
      id: cardId,
      createdAt: new Date().toISOString(),
      action: { ...action, args: { ...action.args } },
      verdict,
      state: 'pending',
      decisionStatus: verdict.kind === 'red' ? 'pending' : 'allowed',
      executionStatus: 'not-started',
      verificationStatus: 'unverified',
      runtimeAttempts: 0,
      externalSideEffect: Boolean(action.args.external),
      humanContext: { request: this.activeSpec.request, constraints, lastAdjudication: this.lastAdjudication },
      assessment: { selfDirected: assessment.selfDirected, drift: assessment.drift, confidence: assessment.confidence, note: assessment.note },
      provenance: { judge: this.judgeName, recorder: this.recorderName },
    }
    if (assessment.deviatesFromInstruction || assessment.drift) card.failureKind = 'recording-drift'
    const timeoutMs = options.timeoutMs ?? this.approvalTimeoutMs
    if (verdict.kind === 'red') card.approvalDeadline = new Date(Date.now() + timeoutMs).toISOString()
    this.cards.push(card)
    this.addEvent('card-created', `${verdict.kind}：${verdict.explanation}`, card.id, agentId, turn, step, {
      card: structuredClone(card),
      humanInstruction: this.humanInstruction,
      agentAction: structuredClone(action),
      selfDirected: assessment.selfDirected,
      confidence: assessment.confidence,
      drift: assessment.drift,
      recordingDeviation: assessment.deviatesFromInstruction,
    }, 'recorder')
    this.addEvent('verdict', `决策判官判定 ${verdict.kind}`, card.id, agentId, turn, step, { role: 'decision-judge', failureKind: verdict.failureKind, judge: this.judgeName }, 'judge')
    if (card.failureKind === 'recording-drift') {
      this.addEvent('failure', assessment.note, card.id, agentId, turn, step, { failureKind: 'recording-drift', blocking: false, confidence: assessment.confidence }, 'recorder')
    }

    const combined = this.abortRelay([this.controller.signal, this.agentControllers.get(agentId)!.signal, turnController.signal, options.signal, options.agentSignal])
    if (verdict.kind !== 'red') return this.runExecutor(card, combined.signal)
    return new Promise<ActionResult>((resolve) => {
      const gate: Gate = {
        card,
        signal: combined.signal,
        resolve: (result) => {
          if (gate.timer) clearTimeout(gate.timer)
          this.gates.delete(card.id)
          resolve(result)
        },
      }
      this.gates.set(card.id, gate)
      combined.signal.addEventListener('abort', () => this.settleCancelled(card.id, String(combined.signal.reason ?? '已取消')), { once: true })
      gate.timer = setTimeout(() => this.settleCancelled(card.id, '审批超时，已 fail-closed'), timeoutMs)
      if (combined.signal.aborted) this.settleCancelled(card.id, String(combined.signal.reason ?? '已取消'))
      const queued = this.queuedDecisions.get(card.id)
      if (queued) {
        this.queuedDecisions.delete(card.id)
        this.decide(card.id, queued)
      }
    })
  }

  /** Executes one semantic unit and keeps all of its tool calls on one card. */
  async executeUnit(input: WorkUnitInput, options: ExecuteOptions = {}): Promise<ActionResult> {
    this.assertActive()
    if (!this.activeSpec) throw new DecisionStreamError(409, 'spec_required', 'confirm a spec before executing actions')
    const agentId = input.agentId ?? input.toolCalls[0]?.agentId ?? 'demo-agent'
    if (input.id && this.cards.some((card) => card.id === input.id)) throw new DecisionStreamError(409, 'duplicate_card', `duplicate card id: ${input.id}`)
    this.registerAgent(agentId)
    const turn = ++this.turn
    const step = ++this.step
    const identity: ActionIdentity = { sessionId: this.sessionId, branchId: this.activeBranch, agentId, turn, step }
    const turnController = new AbortController()
    this.turnControllers.set(turn, turnController)
    const decisions = input.decisions.map((item) => ({ ...item }))
    const constraints = [...structureSpecConstraints(this.activeSpec)]
    const matches = matchDecisions(decisions, constraints, { request: this.activeSpec.request, constraintTexts: this.activeSpec.constraints, turn })
    const verdict = verdictForUnit(input, matches, constraints)
    const action = input.toolCalls[0] ?? { tool: 'work-unit', kind: 'validate' as const, description: input.goal, args: {}, agentId }
    const assessment = await this.recorder.assess({ ...identity, humanInstruction: this.humanInstruction, constraints: this.activeSpec.constraints, lastAdjudication: this.lastAdjudication, action })
    const card: DecisionCard = {
      ...identity, id: input.id ?? this.nextCardId(), createdAt: new Date().toISOString(), action: { ...action, args: { ...action.args } }, verdict,
      state: 'pending', decisionStatus: verdict.kind === 'red' ? 'pending' : 'allowed', executionStatus: 'not-started', verificationStatus: 'unverified',
      runtimeAttempts: 0, externalSideEffect: input.toolCalls.some((call) => Boolean(call.args.external)),
      humanContext: { request: this.activeSpec.request, constraints: [...this.activeSpec.constraints], lastAdjudication: this.lastAdjudication },
      assessment: { selfDirected: assessment.selfDirected, drift: assessment.drift, confidence: assessment.confidence, note: assessment.note },
      provenance: { judge: this.judgeName, recorder: this.recorderName },
      unit: { goal: input.goal, decisions, matches, toolCalls: input.toolCalls.map((call) => ({ action: { ...call, args: { ...call.args } }, status: 'not-started', attempts: 0 })) },
    }
    if (assessment.drift) card.failureKind = 'recording-drift'
    if (verdict.kind === 'red') card.approvalDeadline = new Date(Date.now() + (options.timeoutMs ?? this.approvalTimeoutMs)).toISOString()
    this.cards.push(card)
    this.units.set(card.id, card)
    this.addEvent('turn-start', `第 ${turn} 轮开始`, undefined, agentId, turn, step)
    this.addEvent('step-start', `第 ${step} 步开始`, undefined, agentId, turn, step)
    this.addEvent('card-created', `${verdict.kind}：${verdict.explanation}`, card.id, agentId, turn, step, { card: structuredClone(card), unit: card.unit }, 'judge')
    const combined = this.abortRelay([this.controller.signal, this.agentControllers.get(agentId)!.signal, turnController.signal, options.signal, options.agentSignal])
    if (verdict.kind !== 'red') return this.isExternalUnit(card) ? this.admitExternalUnit(card) : this.runUnitExecutor(card, combined.signal)
    return new Promise<ActionResult>((resolve) => {
      const gate: Gate = { card, signal: combined.signal, resolve: (result) => { if (gate.timer) clearTimeout(gate.timer); this.gates.delete(card.id); resolve(result) } }
      this.gates.set(card.id, gate)
      gate.timer = setTimeout(() => this.settleCancelled(card.id, '审批超时，已 fail-closed'), options.timeoutMs ?? this.approvalTimeoutMs)
      combined.signal.addEventListener('abort', () => this.settleCancelled(card.id, String(combined.signal.reason ?? '已取消')), { once: true })
      const queued = this.queuedDecisions.get(card.id)
      if (queued) { this.queuedDecisions.delete(card.id); this.decide(card.id, queued) }
    })
  }

  async executeInUnit(unitId: string, action: ActionInput, options: ExecuteOptions = {}): Promise<ActionResult> {
    this.assertActive()
    const card = this.units.get(unitId)
    if (!card?.unit) throw new DecisionStreamError(404, 'unknown_unit', `unknown unit: ${unitId}`)
    if (card.state === 'cancelled' || card.state === 'failed') return { allowed: false, reason: '单元不可继续执行', card, branchId: card.branchId }
    card.unit.toolCalls.push({ action, status: 'not-started', attempts: 0 })
    const call = card.unit.toolCalls.at(-1)!
    return this.isExternalUnit(card) ? this.admitExternalTool(card, call) : this.runUnitTool(card, call, options.signal ?? this.signal)
  }

  /** dsh owns execution; the workbench only admits it and records its final result. */
  private isExternalUnit(card: DecisionCard): boolean {
    return Boolean(card.unit?.toolCalls.some((call) => call.action.args.source === 'dsh'))
  }

  private admitExternalUnit(card: DecisionCard): ActionResult {
    card.executionStatus = 'running'
    card.state = card.decisionStatus === 'overridden' ? 'overridden' : 'allowed'
    for (const call of card.unit?.toolCalls ?? []) {
      call.status = 'running'
      this.addEvent('tool-call', `dsh 已获准执行：${call.action.description}`, card.id, card.agentId, card.turn, card.step, { action: call.action, unitId: card.id, external: true }, 'agent')
    }
    return { allowed: true, card, branchId: card.branchId }
  }

  private admitExternalTool(card: DecisionCard, call: UnitToolCall): ActionResult {
    call.status = 'running'
    this.addEvent('tool-call', `dsh 已获准执行：${call.action.description}`, card.id, card.agentId, card.turn, card.step, { action: call.action, unitId: card.id, external: true }, 'agent')
    return { allowed: true, card, branchId: card.branchId }
  }

  /** Records dsh lifecycle events and authoritative results without inventing success. */
  recordAdapterEvent(event: Record<string, unknown>): void {
    this.assertActive()
    const type = typeof event.type === 'string' ? event.type : 'adapter-event'
    const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
      ? event.payload as Record<string, unknown>
      : {}
    if (type === 'tool-result') {
      this.recordExternalToolResult(payload)
      return
    }
    const metadata: Record<string, unknown> = { adapterEvent: event, dshType: type }
    this.addEvent('adapter-event', `dsh ${type}`, undefined, typeof event.agentId === 'string' ? event.agentId : undefined, typeof event.turn === 'number' ? event.turn : undefined, typeof event.step === 'number' ? event.step : undefined, metadata, 'stream')
  }

  private recordExternalToolResult(payload: Record<string, unknown>): void {
    const unitId = typeof payload.unitId === 'string' ? payload.unitId : undefined
    const callId = typeof payload.callId === 'string' ? payload.callId : undefined
    const card = unitId ? this.units.get(unitId) : undefined
    const call = card?.unit?.toolCalls.find((item) => item.action.args.callId === callId)
    if (!card || !call || !callId) throw new DecisionStreamError(404, 'unknown_external_call', 'dsh tool-result does not match a pending work-unit call')
    const ok = payload.ok === true
    call.status = ok ? 'succeeded' : 'failed'
    call.result = ok ? { ok: true, output: payload.output } : { ok: false, error: typeof payload.error === 'string' ? payload.error : 'dsh tool execution failed' }
    call.attempts = Math.max(call.attempts, 1)
    if (payload.evidence && typeof payload.evidence === 'object') {
      call.evidence = { ...(payload.evidence as VerificationEvidence), cardId: card.id, executionId: call.executionId ?? `${card.id}:${callId}`, source: 'executor' }
      if (call.evidence.passed) { card.verification = call.evidence; card.verificationStatus = 'passed' }
    }
    this.addEvent(ok ? 'tool-result' : 'failure', ok ? 'dsh executor 已回写真实工具结果' : 'dsh executor 工具执行失败', card.id, card.agentId, card.turn, card.step, { ...payload, external: true }, 'executor')
    if (!ok) {
      card.executionStatus = 'failed'; card.state = 'failed'; card.failureKind = 'runtime-error'; this.finishTurn(card); return
    }
    if (card.unit?.toolCalls.every((item) => item.status === 'succeeded')) {
      card.executionStatus = 'succeeded'
      card.state = card.verificationStatus === 'passed' ? 'verified' : card.decisionStatus === 'overridden' ? 'overridden' : 'allowed'
      this.finishTurn(card)
    }
  }

  private async runUnitExecutor(card: DecisionCard, signal: AbortSignal): Promise<ActionResult> {
    if (!card.unit?.toolCalls.length) {
      card.executionStatus = 'succeeded'; card.state = card.decisionStatus === 'overridden' ? 'overridden' : 'allowed'
      this.finishTurn(card)
      return { allowed: true, card, branchId: card.branchId }
    }
    for (const call of card.unit?.toolCalls ?? []) {
      const result = await this.runUnitTool(card, call, signal)
      if (!result.allowed) return result
    }
    card.executionStatus = 'succeeded'; card.state = card.verificationStatus === 'passed' ? 'verified' : card.decisionStatus === 'overridden' ? 'overridden' : 'allowed'
    this.finishTurn(card)
    return { allowed: true, card, branchId: card.branchId, toolResult: { ok: true, executionId: `${card.id}:unit`, cardId: card.id } }
  }

  private async runUnitTool(card: DecisionCard, call: UnitToolCall, signal: AbortSignal, policyAllowed = false): Promise<ActionResult> {
    const inferred = extractDecisions(call.action)
    const constraints = structureSpecConstraints(this.activeSpec!)
    const safety = matchDecisions(inferred, constraints, { request: this.activeSpec!.request, constraintTexts: this.activeSpec!.constraints, turn: card.turn }).find((item) => isConstraintConflict(item.outcome) && !card.unit!.decisions.some((decision) => decision.domain === item.decision.domain && decision.choice === item.decision.choice))
    if (safety && !policyAllowed) {
      call.status = 'blocked'; call.safetyNet = { outcome: safety.outcome, explanation: `${safety.explanation}（来源：policy safety net）`, source: 'policy-safety-net' }
      card.failureKind = 'constraint-conflict'; card.verdict = { ...card.verdict, kind: 'red', failureKind: 'constraint-conflict', explanation: safety.explanation }
      card.state = 'pending'; card.decisionStatus = 'pending'
      this.addEvent('failure', call.safetyNet.explanation, card.id, card.agentId, card.turn, card.step, { failureKind: 'constraint-conflict', blocking: true, source: 'policy-safety-net' }, 'stream')
      return new Promise<ActionResult>((resolve) => {
        const gate: Gate = {
          card, signal, resume: () => this.runUnitTool(card, call, signal, true),
          resolve: (result) => { if (gate.timer) clearTimeout(gate.timer); this.gates.delete(card.id); resolve(result) },
        }
        this.gates.set(card.id, gate)
        gate.timer = setTimeout(() => this.settleCancelled(card.id, '审批超时，已 fail-closed'), this.approvalTimeoutMs)
        signal.addEventListener('abort', () => this.settleCancelled(card.id, String(signal.reason ?? '已取消')), { once: true })
      })
    }
    call.status = 'running'; call.attempts = 0
    const executionId = `${card.id}:tool-${card.unit!.toolCalls.indexOf(call) + 1}`; call.executionId = executionId
    this.addEvent('tool-call', `单元执行：${call.action.description}`, card.id, card.agentId, card.turn, card.step, { action: call.action, unitId: card.id }, 'agent')
    let result: ExecutorResult = { ok: false, error: 'not attempted' }
    while (call.attempts < MAX_RUNTIME_ATTEMPTS && !signal.aborted) {
      call.attempts++
      try { result = await this.executor.execute({ ...card, cardId: card.id, executionId, action: call.action, signal }) } catch (error) { result = { ok: false, error: error instanceof Error ? error.message : String(error) } }
      if (result.ok) break
    }
    call.result = result
    if (signal.aborted) result = { ok: false, error: String(signal.reason ?? '执行已取消') }
    if (!result.ok) { call.status = signal.aborted ? 'skipped' : 'failed'; card.executionStatus = signal.aborted ? 'cancelled' : 'failed'; card.state = signal.aborted ? 'cancelled' : 'failed'; card.failureKind = 'runtime-error'; this.finishTurn(card); return { allowed: false, reason: result.error ?? '执行失败', card, branchId: card.branchId, toolResult: { ok: false, error: result.error, executionId, cardId: card.id } } }
    call.status = 'succeeded'; this.addEvent('tool-result', 'executor 已真实执行单元动作', card.id, card.agentId, card.turn, card.step, { executionId, attempts: call.attempts, output: result.output }, 'executor')
    if (result.verification) { call.evidence = { ...result.verification, cardId: card.id, executionId, source: 'executor' }; card.verification = call.evidence; card.verificationStatus = call.evidence.passed ? 'passed' : 'failed' }
    return { allowed: true, card, branchId: card.branchId, toolResult: { ok: true, output: result.output, executionId, cardId: card.id } }
  }

  private nextCardId(): string {
    let id: string
    do id = `card-${++this.counter}`
    while (this.cards.some((card) => card.id === id))
    return id
  }

  private async runExecutor(card: DecisionCard, signal: AbortSignal): Promise<ActionResult> {
    card.executionStatus = 'running'
    card.executionId = `${card.id}:execution`
    const identity: ActionIdentity = { sessionId: card.sessionId, branchId: card.branchId, agentId: card.agentId, turn: card.turn, step: card.step }
    let result: ExecutorResult = { ok: false, error: 'not attempted' }
    for (let attempt = 1; attempt <= MAX_RUNTIME_ATTEMPTS; attempt++) {
      card.runtimeAttempts = attempt
      if (signal.aborted) break
      try {
        result = await this.executor.execute({ ...identity, cardId: card.id, executionId: card.executionId, action: card.action, signal })
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      if (result.ok) break
      this.addEvent('failure', result.error ?? 'executor failed', card.id, card.agentId, card.turn, card.step, { failureKind: 'runtime-error', attempt, retrying: attempt < MAX_RUNTIME_ATTEMPTS }, 'executor')
    }
    // Executors may ignore AbortSignal. Cancellation wins over a late success.
    if (signal.aborted) result = { ok: false, error: String(signal.reason ?? '执行已取消') }
    if (!result.ok) {
      const aborted = signal.aborted
      card.executionStatus = aborted ? 'cancelled' : 'failed'
      card.state = aborted ? 'cancelled' : 'failed'
      card.failureKind = 'runtime-error'
      card.blockedHelp = !aborted
      this.addEvent('failure', aborted ? '执行已取消' : `运行连续失败 ${card.runtimeAttempts} 次，已升级为阻塞求助：${result.error ?? 'runtime failure'}`, card.id, card.agentId, card.turn, card.step, { failureKind: 'runtime-error', blockedHelp: !aborted, attempts: card.runtimeAttempts, cancelled: aborted }, 'executor')
      this.finishTurn(card)
      return { allowed: false, reason: aborted ? '执行已取消' : '运行失败，已升级为阻塞求助', card, branchId: card.branchId, toolResult: { ok: false, error: result.error, executionId: card.executionId, cardId: card.id } }
    }
    card.executionStatus = 'succeeded'
    card.state = card.decisionStatus === 'overridden' ? 'overridden' : 'allowed'
    this.addEvent('tool-result', 'executor 已真实执行动作', card.id, card.agentId, card.turn, card.step, { executionId: card.executionId, output: result.output, externalSideEffect: result.externalSideEffect ?? card.externalSideEffect, attempts: card.runtimeAttempts }, 'executor')
    if (result.verification) this.verify(card.id, true, { ...result.verification, source: 'executor', cardId: card.id, executionId: card.executionId })
    this.finishTurn(card)
    return { allowed: true, card, branchId: card.branchId, toolResult: { ok: true, output: result.output, executionId: card.executionId, cardId: card.id } }
  }

  private finishTurn(card: DecisionCard): void {
    if (this.completedTurns.has(card.turn)) return
    this.completedTurns.add(card.turn)
    this.turnControllers.delete(card.turn)
    this.addEvent('turn-end', `第 ${card.turn} 轮结束`, card.id, card.agentId, card.turn, card.step)
  }

  private addConstraint(constraint: string): void {
    if (!this.activeSpec || this.activeSpec.constraints.includes(constraint)) return
    this.activeSpec.constraints.push(constraint)
    const additions = structureConstraint(constraint, { id: `adjudication-${this.sequence + 1}`, source: 'adjudication', affectsFromTurn: this.turn })
    this.activeSpec.structuredConstraints = [...structureSpecConstraints(this.activeSpec), ...additions]
  }

  addHumanConstraint(text: string, structured?: NonNullable<ConfirmedSpec['structuredConstraints']>[number]): void {
    this.assertActive()
    const value = text.trim()
    if (!value) throw new DecisionStreamError(400, 'invalid_constraint', 'constraint text is required')
    const additions = structured
      ? [{ ...structured, text: structured.text || value, source: 'adjudication' as const, createdAt: structured.createdAt ?? new Date().toISOString(), affectsFromTurn: this.turn }]
      : structureConstraint(value, { id: `adjudication-${this.sequence + 1}`, source: 'adjudication', affectsFromTurn: this.turn })
    if (!this.activeSpec) throw new DecisionStreamError(409, 'spec_required', 'confirm a spec before adding constraints')
    if (!this.activeSpec.constraints.includes(value)) this.activeSpec.constraints.push(value)
    this.activeSpec.structuredConstraints = [...structureSpecConstraints(this.activeSpec), ...additions]
    this.addEvent('injection', `新增后续约束：${value}`, undefined, undefined, this.turn, undefined, { constraint: additions, affects: 'future-only' }, 'human')
  }

  private settleCancelled(cardId: string, reason: string, byHuman = false): void {
    const gate = this.gates.get(cardId)
    if (!gate || gate.card.state !== 'pending') return
    const card = gate.card
    card.state = 'cancelled'
    card.decisionStatus = 'cancelled'
    card.executionStatus = 'cancelled'
    card.approvalDeadline = undefined
    this.addEvent('cancel', reason, card.id, card.agentId, card.turn, card.step, { failClosed: !byHuman, byHuman }, 'stream')
    this.finishTurn(card)
    gate.resolve({ allowed: false, reason, card, branchId: card.branchId })
  }

  // ---------------------------------------------------------------------------
  // Human decisions
  // ---------------------------------------------------------------------------

  decide(cardId: string, decision: HumanDecision): void {
    this.assertActive()
    const gate = this.gates.get(cardId)
    if (gate && gate.card.state === 'pending') {
      this.decideGate(gate, decision)
      return
    }
    const card = this.cards.find((item) => item.id === cardId)
    if (!card) {
      // The card may still be judged; the decision is applied as soon as its gate opens.
      this.queuedDecisions.set(cardId, decision)
      return
    }
    if (this.verdicts.get(cardId) === JSON.stringify(decision)) return
    if (card.executionStatus === 'succeeded' || card.executionStatus === 'failed') {
      this.decidePostHoc(card, decision)
      return
    }
    throw new DecisionStreamError(409, 'conflicting_verdict', `conflicting verdict for ${cardId}: card is already ${card.state}`)
  }

  private decideGate(gate: Gate, decision: HumanDecision): void {
    const { card } = gate
    const key = JSON.stringify(decision)
    if (gate.decision) {
      if (JSON.stringify(gate.decision) === key) return
      throw new DecisionStreamError(409, 'conflicting_verdict', `conflicting verdict for ${card.id}`)
    }
    gate.decision = decision
    this.verdicts.set(card.id, key)
    this.addEvent('human-adjudication', adjudicationMessage(decision), card.id, card.agentId, card.turn, card.step, { decision, postHoc: false }, 'human')
    card.approvalDeadline = undefined
    if (decision.kind === 'cancel') {
      this.settleCancelled(card.id, '已被人工叫停', true)
      return
    }
    if (decision.kind === 'allow') {
      card.decisionStatus = 'allowed'
      card.state = 'allowed'
      void this.runAfterGate(gate)
      return
    }
    card.decisionStatus = 'overridden'
    card.state = 'overridden'
    card.appliedConstraint = decision.text
    this.lastAdjudication = decision.text
    if (this.mode === 'forward-only') {
      this.addConstraint(decision.text)
      this.finishTurn(card)
      this.addEvent('injection', `forward-only：约束只影响后续：${decision.text}`, card.id, card.agentId, card.turn, card.step, { affects: 'future-only', constraint: decision.text, postHoc: false })
      gate.resolve({ allowed: false, reason: `已拒绝原动作并注入后续约束：${decision.text}`, card, branchId: card.branchId })
      return
    }
    this.finishTurn(card)
    const fork = this.rewindAndFork(card.turn, decision.text, 'adjudication')
    this.addEvent('injection', `新分支收到重做指令：${decision.text}`, card.id, card.agentId, card.turn, card.step, { branchId: fork.branchId, constraint: decision.text, postHoc: false })
    gate.resolve({ allowed: false, reason: `已保留原分支并从 turn ${card.turn} fork 新分支`, card, branchId: fork.branchId })
  }

  /**
   * Post-hoc override of a card that already executed (blue/gray/green/failed, or an allowed red).
   * History is never rewritten: the card keeps its state and the correction is appended as new events.
   */
  private decidePostHoc(card: DecisionCard, decision: HumanDecision): void {
    if (decision.kind === 'cancel') throw new DecisionStreamError(409, 'card_executed', `card ${card.id} has already executed and cannot be cancelled after the fact`)
    const previous = card.postHocDecision
    if (previous) {
      const text = 'text' in decision ? decision.text : undefined
      if (previous.kind === decision.kind && previous.text === text) return
      if (previous.kind !== 'allow') throw new DecisionStreamError(409, 'conflicting_verdict', `conflicting verdict for ${card.id}: already overridden after the fact`)
    }
    const record: PostHocDecision = { kind: decision.kind, text: 'text' in decision ? decision.text : undefined, at: new Date().toISOString() }
    card.postHocDecision = record
    this.addEvent('human-adjudication', `事后${adjudicationMessage(decision)}`, card.id, card.agentId, card.turn, card.step, { decision, postHoc: true }, 'human')
    if (decision.kind === 'allow') return
    card.appliedConstraint = decision.text
    this.lastAdjudication = decision.text
    if (this.mode === 'forward-only') {
      this.addConstraint(decision.text)
      this.addEvent('injection', `forward-only：事后翻案，约束只影响后续：${decision.text}`, card.id, card.agentId, card.turn, card.step, { affects: 'future-only', constraint: decision.text, postHoc: true })
      return
    }
    const boundary = card.turn - 1
    const fork = this.rewindAndFork(boundary, decision.text, 'adjudication')
    this.addEvent('injection', `事后翻案：从 turn ${boundary} 边界 fork 并重做：${decision.text}`, card.id, card.agentId, card.turn, card.step, { branchId: fork.branchId, constraint: decision.text, postHoc: true })
  }

  private async runAfterGate(gate: Gate): Promise<void> {
    const result = gate.resume ? await gate.resume() : gate.card.unit ? (this.isExternalUnit(gate.card) ? this.admitExternalUnit(gate.card) : await this.runUnitExecutor(gate.card, gate.signal)) : await this.runExecutor(gate.card, gate.signal)
    gate.resolve(result)
  }

  verify(cardId: string, passed: boolean, evidence?: VerificationEvidence | string | { kind: VerificationEvidence['kind']; detail: string; passed: boolean }): void {
    const card = this.cards.find((item) => item.id === cardId)
    if (!card || card.executionStatus !== 'succeeded' || !card.executionId) return
    const record: VerificationEvidence = typeof evidence === 'string'
      ? { cardId, executionId: card.executionId, source: 'human', kind: 'explicit-check', detail: evidence, passed }
      : evidence && 'source' in evidence
        ? evidence
        : evidence
          ? { ...evidence, cardId, executionId: card.executionId, source: 'human' }
          : { cardId, executionId: card.executionId, source: 'human', kind: 'explicit-check', detail: '人工确认验证动作通过', passed }
    if (record.cardId !== cardId || record.executionId !== card.executionId) return
    card.verification = record
    card.verificationStatus = record.passed && record.source === 'executor' ? 'passed' : 'failed'
    if (card.verificationStatus === 'passed') card.state = 'verified'
    const controlled = record.source === 'executor'
    this.addEvent('verification', record.passed && controlled ? `验证证据通过：${record.detail}` : `验证未通过或来源不受控：${record.detail}`, card.id, card.agentId, card.turn, card.step, { evidence: record, controlled }, controlled ? 'executor' : 'human')
  }

  fail(cardId: string, failureKind: FailureKind, reason: string): void {
    const card = this.cards.find((item) => item.id === cardId)
    if (!card) return
    card.failureKind = failureKind
    if (failureKind !== 'recording-drift') {
      card.state = 'failed'
      card.executionStatus = 'failed'
      card.verificationStatus = 'failed'
      card.verification = undefined
    }
    this.addEvent('failure', reason, card.id, card.agentId, card.turn, card.step, { failureKind, blocking: failureKind === 'constraint-conflict' }, failureKind === 'recording-drift' ? 'recorder' : 'executor')
  }

  // ---------------------------------------------------------------------------
  // Branching
  // ---------------------------------------------------------------------------

  rewindAndFork(turnBoundary: number, instruction: string, origin: 'human-rewind' | 'adjudication' = 'human-rewind'): { branchId: string; parentBranchId: string; turnBoundary: number } {
    if (this.mode !== 'rewind-and-fork') throw new DecisionStreamError(409, 'rewind_not_enabled', 'rewind-and-fork is not enabled; choose it explicitly when creating the stream')
    if (!Number.isInteger(turnBoundary) || turnBoundary < 0 || (turnBoundary > 0 && !this.completedTurns.has(turnBoundary))) {
      throw new DecisionStreamError(409, 'rewind_boundary', `rewind boundary must be a completed turn boundary (got ${turnBoundary})`)
    }
    const parentBranchId = this.activeBranch
    const branchId = `branch-${this.branches.size}`
    const snapshotId = this.workspace.snapshot({ sessionId: this.sessionId, branchId: parentBranchId, agentId: 'workspace', turn: turnBoundary, step: 0 })
    const parent = this.branches.get(parentBranchId)
    if (parent) parent.active = false
    const createdAt = new Date().toISOString()
    this.branches.set(branchId, { id: branchId, parentId: parentBranchId, forkTurn: turnBoundary, active: true, createdAt })
    this.activeBranch = branchId
    this.addConstraint(instruction)
    this.workspace.fork({ parentBranchId, branchId, turnBoundary, snapshotId })
    const metadata = { parentBranchId, branchId, turnBoundary, snapshotId, externalSideEffects: 'not-reversible', origin }
    this.addEvent('branch-created', `保留原分支 ${parentBranchId}，创建 ${branchId}`, undefined, undefined, turnBoundary, undefined, metadata, 'workspace')
    this.addEvent('fork', `从 turn ${turnBoundary} 重做：${instruction}`, undefined, undefined, turnBoundary, undefined, { ...metadata, constraint: instruction }, 'human')
    return { branchId, parentBranchId, turnBoundary }
  }

  async redo(cardId: string, action?: ActionInput): Promise<ActionResult> {
    const card = this.cards.find((item) => item.id === cardId)
    if (!card) throw new DecisionStreamError(404, 'unknown_card', `unknown card: ${cardId}`)
    if (this.mode !== 'rewind-and-fork' || this.activeBranch === card.branchId) throw new DecisionStreamError(409, 'redo_requires_fork', 'redo requires a rewind-and-fork child branch')
    return this.execute(action ?? { ...card.action, id: undefined, agentId: card.agentId })
  }

  // ---------------------------------------------------------------------------
  // Cancel / end
  // ---------------------------------------------------------------------------

  /** Emergency stop: every pending gate and running executor is aborted; the session itself stays open. */
  cancel(reason = '已被人工叫停'): void {
    if (this.finishedAt || this.sessionCancelRecorded) return
    this.sessionCancelRecorded = true
    this.addEvent('cancel', reason, undefined, undefined, undefined, undefined, { scope: 'session', byHuman: true }, 'human')
    this.abortAll(reason)
  }

  private abortAll(reason: string): void {
    const previous = this.controller
    this.controller = new AbortController()
    for (const [agentId, controller] of this.agentControllers) {
      this.agentControllers.set(agentId, new AbortController())
      controller.abort(reason)
    }
    for (const [turn, controller] of [...this.turnControllers]) {
      this.turnControllers.delete(turn)
      controller.abort(reason)
    }
    previous.abort(reason)
  }

  /** Freezes the session: pending gates fail closed, and no further execution or decision is accepted. */
  end(): void {
    if (this.finishedAt) return
    this.abortAll('会话已结束')
    const endedAt = new Date().toISOString()
    this.finishedAt = endedAt
    this.addEvent('session-end', '会话结束，报告已定稿', undefined, undefined, undefined, undefined, { endedAt }, 'human')
  }

  cancelAgent(agentId: string): void { this.agentControllers.get(agentId)?.abort(`Agent ${agentId} 已取消`) }
  cancelTurn(turn: number): void { this.turnControllers.get(turn)?.abort(`turn ${turn} 已取消`) }
  cancelCard(cardId: string): void { if (this.gates.has(cardId)) this.settleCancelled(cardId, '卡片已取消', true) }

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------

  report(): SessionReport {
    const cards = this.cards
    const nonGray = cards.filter((card) => card.verdict.kind !== 'gray')
    const adjudications = this.timeline.filter((event) => event.type === 'human-adjudication')
    const corrections: CorrectionRecord[] = adjudications.map((event) => {
      const card = event.cardId ? cards.find((item) => item.id === event.cardId) : undefined
      const decision = event.metadata?.decision as HumanDecision | undefined
      const kind = decision?.kind ?? 'allow'
      const after = kind === 'allow' ? (event.metadata?.postHoc ? '人已确认放过' : '按原动作执行') : kind === 'cancel' ? '已叫停' : decision && 'text' in decision ? decision.text : '已裁决'
      return {
        cardId: event.cardId ?? '',
        turn: card?.turn ?? event.turn ?? 0,
        agentId: card?.agentId ?? event.agentId ?? '',
        kind,
        before: card?.action.description ?? '原动作',
        after,
        mode: this.mode,
        at: event.at,
        branchId: card?.branchId ?? event.branchId,
        postHoc: Boolean(event.metadata?.postHoc),
      }
    })
    const overrides = corrections.filter((item) => item.kind === 'alternative' || item.kind === 'rewrite')
    const directionCorrections = overrides.filter((item) => cards.find((card) => card.id === item.cardId)?.verdict.kind === 'red').length
    const allowed = nonGray.filter((card) => card.decisionStatus === 'allowed' && !(card.postHocDecision && card.postHocDecision.kind !== 'allow')).length
    const verified = cards.filter((card) => card.verificationStatus === 'passed').length
    const specConfirmations = this.timeline.filter((event) => event.type === 'human-command' && event.metadata?.spec).length
    const humanStops = this.timeline.filter((event) => event.type === 'cancel' && event.metadata?.scope === 'session').length
    const humanRewinds = this.timeline.filter((event) => event.type === 'fork' && event.metadata?.origin === 'human-rewind').length
    const agentDecisions = nonGray.filter((card) => card.assessment.selfDirected).length
    const byColor: ColorCounts = {
      red: cards.filter((card) => card.verdict.kind === 'red' && card.state !== 'verified' && card.state !== 'failed').length,
      blue: cards.filter((card) => card.verdict.kind === 'blue' && card.state !== 'verified' && card.state !== 'failed').length,
      gray: cards.filter((card) => card.verdict.kind === 'gray' && card.state !== 'verified' && card.state !== 'failed').length,
      green: cards.filter((card) => card.state === 'verified').length,
      failed: cards.filter((card) => card.state === 'failed').length,
    }
    const perAgent: AgentReport[] = this.agents.map((agentId) => {
      const own = cards.filter((card) => card.agentId === agentId)
      return {
        agentId,
        actions: own.length,
        selfDirected: own.filter((card) => card.assessment.selfDirected).length,
        red: own.filter((card) => card.verdict.kind === 'red').length,
        blue: own.filter((card) => card.verdict.kind === 'blue').length,
        gray: own.filter((card) => card.verdict.kind === 'gray').length,
        verified: own.filter((card) => card.state === 'verified').length,
        failed: own.filter((card) => card.state === 'failed').length,
      }
    })
    const endedAt = this.finishedAt
    const durationMs = Math.max(0, new Date(endedAt ?? new Date().toISOString()).getTime() - new Date(this.startedAt).getTime())
    return {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      endedAt,
      durationMs,
      decisions: nonGray.length,
      allowed,
      overrides: overrides.length,
      cancelled: cards.filter((card) => card.state === 'cancelled').length,
      selfDirected: cards.filter((card) => card.assessment.selfDirected).length,
      recordingDeviations: this.timeline.filter((event) => event.type === 'failure' && event.metadata?.failureKind === 'recording-drift').length,
      verified,
      branches: this.branches.size,
      runtimeFailures: this.timeline.filter((event) => event.type === 'failure' && event.metadata?.failureKind === 'runtime-error').length,
      blockedHelp: this.timeline.filter((event) => event.type === 'failure' && event.metadata?.blockedHelp).length,
      verificationEvidence: cards.filter((card) => card.verification?.source === 'executor').length,
      irreversibleSideEffects: cards.filter((card) => card.externalSideEffect).length,
      unverified: cards.filter((card) => card.executionStatus === 'succeeded' && card.verificationStatus !== 'passed').length,
      recordingFailures: this.timeline.filter((event) => event.type === 'failure' && event.metadata?.failureKind === 'recording-drift').length,
      humanDecisions: specConfirmations + adjudications.length + humanStops + humanRewinds,
      agentDecisions,
      directionCorrections,
      byColor,
      perAgent,
      corrections,
      summary: `本会话 agent 做了 ${nonGray.length} 个决定，你放过 ${allowed} 个、翻案 ${overrides.length} 次，其中 ${directionCorrections} 次纠正了跑偏的方向；验证通过 ${verified} 个。`,
      events: this.events,
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private abortRelay(signals: (AbortSignal | undefined)[]): AbortController {
    const controller = new AbortController()
    for (const signal of signals.filter(Boolean) as AbortSignal[]) {
      if (signal.aborted) controller.abort(signal.reason)
      else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
    }
    return controller
  }

  private addEvent(type: TimelineEventType, message: string, cardId?: string, agentId?: string, turn?: number, step?: number, metadata?: Record<string, unknown>, source: TimelineEventSource = 'stream'): void {
    if (this.finishedAt && type !== 'session-end') return
    const sequence = ++this.sequence
    const branchId = (cardId && this.cards.find((card) => card.id === cardId)?.branchId) ?? this.activeBranch
    const event: TimelineEvent = { id: `event-${sequence}`, sequence, at: new Date().toISOString(), type, source, sessionId: this.sessionId, branchId, agentId, turn, step, cardId, message, metadata }
    this.timeline.push(event)
    this.persistence?.append(event)
    for (const listener of this.listeners) {
      try { listener({ ...event, metadata: event.metadata && { ...event.metadata } }) } catch { /* a broken subscriber must not break the stream */ }
    }
  }

  /** Rebuilds derived state from the append-only log. Only the final, non-retrying failure marks a card failed. */
  private restore(events: TimelineEvent[]): void {
    for (const event of events) {
      this.timeline.push(structuredClone(event))
      this.sequence = Math.max(this.sequence, event.sequence)
      this.turn = Math.max(this.turn, event.turn ?? 0)
      this.step = Math.max(this.step, event.step ?? 0)
      const card = event.cardId ? this.cards.find((item) => item.id === event.cardId) : undefined
      switch (event.type) {
        case 'session-start': {
          this.startedAt = event.at
          const main = this.branches.get('main')
          if (main) main.createdAt = event.at
          if (typeof event.metadata?.title === 'string') this.explicitTitle = event.metadata.title
          break
        }
        case 'session-end':
          this.finishedAt = event.at
          break
        case 'agent-registered':
          if (event.agentId) { this.agentIds.add(event.agentId); this.agentControllers.set(event.agentId, new AbortController()) }
          break
        case 'human-command':
          if (event.metadata?.spec) this.activeSpec = structuredClone(event.metadata.spec) as ConfirmedSpec
          break
        case 'card-created':
          if (event.metadata?.card) this.cards.push(restoredCard(structuredClone(event.metadata.card) as DecisionCard))
          break
        case 'branch-created':
          if (event.metadata?.branchId) {
            const parent = this.branches.get(String(event.metadata.parentBranchId))
            if (parent) parent.active = false
            this.branches.set(String(event.metadata.branchId), { id: String(event.metadata.branchId), parentId: String(event.metadata.parentBranchId), forkTurn: Number(event.metadata.turnBoundary), active: true, createdAt: event.at })
          }
          break
        case 'fork':
          if (event.metadata?.branchId) this.activeBranch = String(event.metadata.branchId)
          break
        case 'human-adjudication': {
          const decision = event.metadata?.decision as HumanDecision | undefined
          if (!card || !decision) break
          const text = 'text' in decision ? decision.text : undefined
          if (event.metadata?.postHoc) {
            if (decision.kind !== 'cancel') card.postHocDecision = { kind: decision.kind, text, at: event.at }
          } else {
            this.verdicts.set(card.id, JSON.stringify(decision))
            card.decisionStatus = decision.kind === 'allow' ? 'allowed' : decision.kind === 'cancel' ? 'cancelled' : 'overridden'
            card.state = card.decisionStatus
            card.approvalDeadline = undefined
          }
          if (text) { card.appliedConstraint = text; this.lastAdjudication = text }
          break
        }
        case 'injection':
          if (event.metadata?.constraint) this.addConstraint(String(event.metadata.constraint))
          break
        case 'tool-result':
          if (card) {
            card.executionStatus = 'succeeded'
            card.executionId = card.executionId ?? `${card.id}:execution`
            if (card.decisionStatus === 'pending') card.decisionStatus = 'allowed'
            card.state = card.decisionStatus === 'overridden' ? 'overridden' : 'allowed'
            card.runtimeAttempts = Number(event.metadata?.attempts ?? Math.max(card.runtimeAttempts, 1))
          }
          break
        case 'verification':
          if (card && event.metadata?.evidence) {
            card.verification = event.metadata.evidence as VerificationEvidence
            card.verificationStatus = card.verification.passed && card.verification.source === 'executor' ? 'passed' : 'failed'
            if (card.verificationStatus === 'passed') card.state = 'verified'
          }
          break
        case 'failure': {
          if (!card) break
          const failureKind = event.metadata?.failureKind as FailureKind | undefined
          if (failureKind === 'recording-drift') {
            if (card.state !== 'failed') card.failureKind = 'recording-drift'
            break
          }
          if (event.metadata?.retrying) {
            card.runtimeAttempts = Math.max(card.runtimeAttempts, Number(event.metadata.attempt ?? 0))
            break
          }
          card.failureKind = failureKind
          card.runtimeAttempts = Math.max(card.runtimeAttempts, Number(event.metadata?.attempts ?? 0))
          card.executionId = card.executionId ?? `${card.id}:execution`
          if (event.metadata?.cancelled) {
            card.state = 'cancelled'
            card.executionStatus = 'cancelled'
          } else {
            card.state = 'failed'
            card.executionStatus = 'failed'
            if (event.metadata?.blockedHelp) card.blockedHelp = true
          }
          break
        }
        case 'cancel':
          if (card) {
            const interrupted = Boolean(event.metadata?.interrupted)
            card.state = interrupted ? 'interrupted' : 'cancelled'
            card.decisionStatus = interrupted ? 'interrupted' : 'cancelled'
            card.executionStatus = interrupted ? 'interrupted' : 'cancelled'
            card.approvalDeadline = undefined
            if (event.metadata?.byHuman) this.verdicts.set(card.id, JSON.stringify({ kind: 'cancel' }))
          }
          break
        case 'turn-end':
          if (event.turn) this.completedTurns.add(event.turn)
          break
        default:
          break
      }
    }
    for (const card of this.cards) {
      const unfinished = card.state === 'pending' || (card.decisionStatus === 'allowed' && (card.executionStatus === 'not-started' || card.executionStatus === 'running'))
      if (!unfinished) continue
      card.state = 'interrupted'
      card.decisionStatus = 'interrupted'
      card.executionStatus = 'interrupted'
      card.approvalDeadline = undefined
      this.addEvent('cancel', '重启后未完成的人审 gate 已标记为 interrupted', card.id, card.agentId, card.turn, card.step, { interrupted: true }, 'stream')
    }
  }
}

/** Older logs predate the v2 card fields; fill them so restored cards satisfy the contract. */
function restoredCard(card: DecisionCard): DecisionCard {
  card.humanContext ??= { request: '', constraints: [] }
  card.assessment ??= { selfDirected: card.action.specified !== true, drift: card.failureKind === 'recording-drift', confidence: 0, note: '' }
  card.provenance ??= { judge: 'unknown', recorder: 'unknown' }
  card.runtimeAttempts ??= 0
  if (card.decisionStatus === 'pending' && card.verdict.kind !== 'red') card.decisionStatus = 'allowed'
  return card
}

function adjudicationMessage(decision: HumanDecision): string {
  if (decision.kind === 'allow') return '人工放行原动作'
  if (decision.kind === 'cancel') return '人工叫停此卡'
  return `人工${decision.kind === 'alternative' ? '选择备选' : '改写'}：${decision.text}`
}

export function cardStateLabel(state: CardState): string { return state === 'verified' ? 'green' : state }
