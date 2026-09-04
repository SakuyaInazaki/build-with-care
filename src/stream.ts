import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { DeterministicJudge, DeterministicRecorder, type DecisionJudge, type DecisionRecorder } from './judge.js'
import type { ActionInput, ActionResult, ActionIdentity, AgentExecutor, CardState, ConfirmedSpec, CorrectionMode, DecisionCard, ExecutorResult, EventPersistence, FailureKind, HumanDecision, SessionReport, TimelineEvent, ToolResult, VerificationEvidence, WorkspaceSnapshotAdapter } from './types.js'

const runFile = promisify(execFile)
type Branch = { id: string; parentId?: string; forkTurn?: number; active: boolean }
type Gate = { card: DecisionCard; signal: AbortSignal; resolve: (result: ActionResult) => void; timer?: ReturnType<typeof setTimeout>; decision?: HumanDecision }
type ExecuteOptions = { signal?: AbortSignal; timeoutMs?: number; agentSignal?: AbortSignal }

export class LocalAgentExecutor implements AgentExecutor {
  constructor(private readonly workspaceRoot = process.cwd()) {}
  private safePath(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error('path is required')
    const root = realpathSync(resolve(this.workspaceRoot)); const path = resolve(root, value)
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
  async execute({ action, signal, executionId, cardId }: import('./types.js').ExecutorInput): Promise<ExecutorResult> {
    if (signal.aborted) return { ok: false, error: 'executor aborted' }
    try {
      if (action.kind === 'write' && typeof action.args.path === 'string') {
        const path = this.safePath(action.args.path)
        await mkdir(dirname(path), { recursive: true }); await writeFile(path, String(action.args.content ?? ''), 'utf8')
        return { ok: true, output: { path }, externalSideEffect: false }
      }
      if (action.kind === 'read') return { ok: true, output: await readFile(this.safePath(action.args.path), 'utf8') }
      if (action.kind === 'validate') {
        return { ok: true, output: { check: action.description }, verification: { kind: 'check', detail: `本地检查通过：${action.description}`, passed: true }, externalSideEffect: false }
      }
      if (action.kind === 'command' && typeof action.args.command === 'string') {
        const command = action.args.command.trim()
        const match = /^(node|npm)\s+(--version|version|test|run\s+(typecheck|build))$/.exec(command)
        if (!match || /[;&|`$<>]/.test(command)) return { ok: false, error: 'command is not in the demo-safe allowlist' }
        const [executable, ...args] = command.split(/\s+/)
        const result = await runFile(executable!, args, { cwd: this.workspaceRoot, signal })
        return { ok: true, output: result.stdout, externalSideEffect: Boolean(action.args.external) }
      }
      return { ok: true, output: { executed: action.tool }, externalSideEffect: Boolean(action.args.external) }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }
}

class NoopWorkspaceSnapshotAdapter implements WorkspaceSnapshotAdapter {
  snapshot(identity: ActionIdentity): string { return `logical-snapshot:${identity.branchId}:${identity.turn}` }
  fork(): void { /* Physical files require an injected adapter, never implicit rollback. */ }
}

export interface DecisionStreamOptions {
  mode?: CorrectionMode; judge?: DecisionJudge; recorder?: DecisionRecorder; executor?: AgentExecutor
  workspaceSnapshots?: WorkspaceSnapshotAdapter; sessionId?: string; humanInstruction?: string; approvalTimeoutMs?: number; persistence?: EventPersistence; restoredEvents?: TimelineEvent[]
}

export class DecisionStream {
  readonly cards: DecisionCard[] = []
  private readonly timeline: TimelineEvent[] = []
  private readonly gates = new Map<string, Gate>()
  private readonly branches = new Map<string, Branch>()
  private readonly agentControllers = new Map<string, AbortController>()
  private readonly turnControllers = new Map<number, AbortController>()
  private readonly agentIds = new Set<string>()
  private readonly completedTurns = new Set<number>()
  private readonly verdicts = new Map<string, string>()
  private counter = 0; private sequence = 0; private activeSpec?: ConfirmedSpec; private humanInstruction?: string
  private readonly queuedDecisions = new Map<string, HumanDecision>()
  private readonly judge: DecisionJudge; private readonly recorder: DecisionRecorder; private readonly executor: AgentExecutor; private readonly workspace: WorkspaceSnapshotAdapter
  private readonly controller = new AbortController(); private turn = 0; private step = 0; private activeBranch = 'main'
  readonly sessionId: string; readonly mode: CorrectionMode; readonly approvalTimeoutMs: number

  constructor(judgeOrOptions: DecisionJudge | DecisionStreamOptions = {}) {
    const value = judgeOrOptions as DecisionStreamOptions & DecisionJudge
    const options: DecisionStreamOptions = typeof judgeOrOptions === 'object' && typeof value.judge !== 'function' ? value : { judge: judgeOrOptions as DecisionJudge }
    const restoredMode = options.restoredEvents?.find((event) => event.type === 'session-start')?.metadata?.mode
    this.mode = (restoredMode === 'rewind-and-fork' || restoredMode === 'forward-only' ? restoredMode : options.mode ?? 'forward-only'); this.judge = options.judge ?? new DeterministicJudge(); this.recorder = options.recorder ?? new DeterministicRecorder()
    this.executor = options.executor ?? new LocalAgentExecutor(); this.workspace = options.workspaceSnapshots ?? new NoopWorkspaceSnapshotAdapter()
    this.persistence = options.persistence
    this.sessionId = options.sessionId ?? `session-${Date.now()}`; this.humanInstruction = options.humanInstruction; this.approvalTimeoutMs = options.approvalTimeoutMs ?? 30_000
    this.branches.set('main', { id: 'main', active: true })
    if (options.restoredEvents?.length) this.restore(options.restoredEvents)
    else this.addEvent('session-start', `会话开始，纠偏模式：${this.mode}`, undefined, undefined, undefined, undefined, { mode: this.mode })
  }
  confirmSpec(spec: ConfirmedSpec): void { if (!spec.confirmed) throw new Error('spec must be confirmed before execution'); this.activeSpec = { ...spec, constraints: [...spec.constraints] }; this.addEvent('human-command', `已确认 spec：${spec.request}`, undefined, undefined, undefined, undefined, { spec: this.activeSpec }) }
  setHumanInstruction(instruction: string): void { this.humanInstruction = instruction; this.addEvent('human-command', instruction) }
  get spec(): ConfirmedSpec | undefined { return this.activeSpec && { ...this.activeSpec, constraints: [...this.activeSpec.constraints] } }
  get events(): readonly TimelineEvent[] { return this.timeline.map((event) => ({ ...event, metadata: event.metadata && { ...event.metadata } })) }
  get signal(): AbortSignal { return this.controller.signal }; get branchId(): string { return this.activeBranch }
  get branchList(): readonly Branch[] { return [...this.branches.values()].map((branch) => ({ ...branch })) }
  registerAgent(agentId: string): void { if (this.agentIds.has(agentId)) return; this.agentIds.add(agentId); this.agentControllers.set(agentId, new AbortController()); this.addEvent('agent-registered', `Agent ${agentId} 已接入`, undefined, agentId) }

  async execute(action: ActionInput, options: ExecuteOptions = {}): Promise<ActionResult> {
    if (!this.activeSpec) throw new Error('confirm a spec before executing actions')
    const agentId = action.agentId ?? 'demo-agent'; this.registerAgent(agentId); const turn = ++this.turn; const step = ++this.step
    const identity = { sessionId: this.sessionId, branchId: this.activeBranch, agentId, turn, step }
    const turnController = new AbortController(); this.turnControllers.set(turn, turnController)
    this.addEvent('turn-start', `第 ${turn} 轮开始`, undefined, agentId, turn, step); this.addEvent('step-start', `第 ${step} 步开始`, undefined, agentId, turn, step)
    this.addEvent('agent-action', `Agent 准备${action.description}`, undefined, agentId, turn, step, { action: structuredClone(action) })
    const assessment = await this.recorder.assess({ ...identity, humanInstruction: this.humanInstruction, action })
    const verdict = await this.judge.judge({ spec: this.activeSpec, action })
    const cardId = action.id ?? `card-${++this.counter}`; if (this.cards.some((card) => card.id === cardId)) throw new Error(`duplicate card id: ${cardId}`)
    const card: DecisionCard = { ...identity, id: cardId, createdAt: new Date().toISOString(), action: { ...action, args: { ...action.args } }, verdict, state: 'pending', decisionStatus: 'pending', executionStatus: 'not-started', verificationStatus: 'unverified', runtimeAttempts: 0, externalSideEffect: Boolean(action.args.external) }
    if (assessment.deviatesFromInstruction || assessment.drift) card.failureKind = 'recording-drift'
    this.cards.push(card); this.addEvent('card-created', `${verdict.kind}：${verdict.explanation}`, card.id, agentId, turn, step, { card: structuredClone(card), humanInstruction: this.humanInstruction, agentAction: structuredClone(action), selfDirected: assessment.selfDirected, confidence: assessment.confidence, drift: assessment.drift, recordingDeviation: assessment.deviatesFromInstruction }, 'recorder')
    this.addEvent('verdict', `决策判官判定 ${verdict.kind}`, card.id, agentId, turn, step, { role: 'decision-judge', failureKind: verdict.failureKind }, 'judge')
    if (card.failureKind === 'recording-drift') this.addEvent('failure', assessment.note, card.id, agentId, turn, step, { failureKind: 'recording-drift', blocking: false }, 'recorder')
    const combined = this.abortRelay([this.controller.signal, this.agentControllers.get(agentId)!.signal, turnController.signal, options.signal, options.agentSignal])
    if (verdict.kind === 'red') return new Promise((resolve) => { const gate: Gate = { card, signal: combined.signal, resolve: (result) => { if (gate.timer) clearTimeout(gate.timer); this.gates.delete(card.id); resolve(result) } }; this.gates.set(card.id, gate); combined.signal.addEventListener('abort', () => this.settleCancelled(card.id, String(combined.signal.reason ?? '已取消')), { once: true }); gate.timer = setTimeout(() => this.settleCancelled(card.id, '审批超时，已 fail-closed'), options.timeoutMs ?? this.approvalTimeoutMs); if (combined.signal.aborted) this.settleCancelled(card.id, String(combined.signal.reason ?? '已取消')); const queued = this.queuedDecisions.get(card.id); if (queued) { this.queuedDecisions.delete(card.id); this.decide(card.id, queued) } })
    combined.signal.addEventListener('abort', () => this.settleCancelled(card.id, '执行已取消'), { once: true })
    return this.runExecutor(card, combined.signal)
  }

  decide(cardId: string, decision: HumanDecision): void {
    const gate = this.gates.get(cardId); if (!gate || gate.card.state !== 'pending') { if (this.verdicts.has(cardId) && this.verdicts.get(cardId) === JSON.stringify(decision)) return; if (this.verdicts.has(cardId)) throw new Error(`conflicting verdict for ${cardId}`); if (!this.cards.some((card) => card.id === cardId)) { this.queuedDecisions.set(cardId, decision); return }; return }
    const key = JSON.stringify(decision); if (gate.decision) { if (JSON.stringify(gate.decision) === key) return; throw new Error(`conflicting verdict for ${cardId}`) }; gate.decision = decision; this.verdicts.set(cardId, key)
    const { card } = gate
    if (decision.kind === 'cancel') { this.settleCancelled(cardId, '已被人工叫停'); return }
    this.addEvent('human-adjudication', decision.kind === 'allow' ? '人工放行原动作' : `人工${decision.kind === 'alternative' ? '选择备选' : '改写'}：${decision.text}`, card.id, card.agentId, card.turn, card.step, { decision }, 'human')
    if (decision.kind === 'allow') { card.decisionStatus = 'allowed'; card.state = 'allowed'; void this.runAfterGate(gate); return }
    card.decisionStatus = 'overridden'; card.state = 'overridden'; card.appliedConstraint = decision.text
    if (this.mode === 'forward-only') { this.addConstraint(decision.text); this.finishTurn(card); this.addEvent('injection', `forward-only：约束只影响后续：${decision.text}`, card.id, card.agentId, card.turn, card.step, { affects: 'future-only', constraint: decision.text }); gate.resolve({ allowed: false, reason: `已拒绝原动作并注入后续约束：${decision.text}`, card, branchId: card.branchId }); return }
    this.finishTurn(card); const fork = this.rewindAndFork(card.turn, decision.text); this.addEvent('injection', `新分支收到重做指令：${decision.text}`, card.id, card.agentId, card.turn, card.step, { branchId: fork.branchId, constraint: decision.text }); gate.resolve({ allowed: false, reason: `已保留原分支并从 turn ${card.turn} fork 新分支`, card, branchId: fork.branchId })
  }
  private async runAfterGate(gate: Gate): Promise<void> { const result = await this.runExecutor(gate.card, gate.signal); gate.resolve(result) }

  private async runExecutor(card: DecisionCard, signal: AbortSignal): Promise<ActionResult> {
    card.executionStatus = 'running'; card.executionId = `${card.id}:execution`; const identity = card as ActionIdentity
    let result: ExecutorResult = { ok: false, error: 'not attempted' }
     for (let attempt = 1; attempt <= 3; attempt++) { card.runtimeAttempts = attempt; if (signal.aborted) break; try { result = await this.executor.execute({ ...identity, cardId: card.id, executionId: card.executionId, action: card.action, signal }) } catch (error) { result = { ok: false, error: error instanceof Error ? error.message : String(error) } } if (result.ok) break; this.addEvent('failure', result.error ?? 'executor failed', card.id, card.agentId, card.turn, card.step, { failureKind: 'runtime-error', attempt, retrying: attempt < 3 }, 'executor') }
    if (!result.ok) { card.executionStatus = signal.aborted ? 'cancelled' : 'failed'; card.state = 'failed'; card.failureKind = 'runtime-error'; this.addEvent('failure', result.error ?? 'runtime failure escalated to help', card.id, card.agentId, card.turn, card.step, { failureKind: 'runtime-error', blockedHelp: !signal.aborted, attempts: card.runtimeAttempts }, 'executor'); this.finishTurn(card); return { allowed: false, reason: signal.aborted ? '执行已取消' : '运行失败，已升级为阻塞求助', card, branchId: card.branchId, toolResult: { ok: false, error: result.error, executionId: card.executionId, cardId: card.id } } }
    card.executionStatus = 'succeeded'; card.state = card.decisionStatus === 'overridden' ? 'overridden' : 'allowed'; this.addEvent('tool-result', 'executor 已真实执行动作', card.id, card.agentId, card.turn, card.step, { executionId: card.executionId, output: result.output, externalSideEffect: result.externalSideEffect ?? card.externalSideEffect }, 'executor')
    if (result.verification) this.verify(card.id, true, { ...result.verification, source: 'executor', cardId: card.id, executionId: card.executionId })
    this.finishTurn(card); return { allowed: true, card, branchId: card.branchId, toolResult: { ok: true, output: result.output, executionId: card.executionId, cardId: card.id } }
  }
  private finishTurn(card: DecisionCard): void { this.completedTurns.add(card.turn); this.turnControllers.delete(card.turn); this.addEvent('turn-end', `第 ${card.turn} 轮结束`, card.id, card.agentId, card.turn, card.step) }
  private addConstraint(constraint: string): void { if (this.activeSpec && !this.activeSpec.constraints.includes(constraint)) this.activeSpec.constraints.push(constraint) }
  private settleCancelled(cardId: string, reason: string): void { const gate = this.gates.get(cardId); if (!gate || gate.card.state !== 'pending') return; const card = gate.card; card.state = 'cancelled'; card.decisionStatus = 'cancelled'; card.executionStatus = 'cancelled'; this.addEvent('cancel', reason, card.id, card.agentId, card.turn, card.step, { failClosed: true }, 'stream'); this.finishTurn(card); gate.resolve({ allowed: false, reason, card, branchId: card.branchId }) }

  verify(cardId: string, passed: boolean, evidence?: VerificationEvidence | string | { kind: VerificationEvidence['kind']; detail: string; passed: boolean }): void {
    const card = this.cards.find((item) => item.id === cardId); if (!card || card.executionStatus !== 'succeeded' || !card.executionId) return
    const record = typeof evidence === 'string' ? { cardId, executionId: card.executionId, source: 'human' as const, kind: 'explicit-check' as const, detail: evidence, passed } : evidence && 'source' in evidence ? evidence : evidence ? { ...evidence, cardId, executionId: card.executionId, source: 'human' as const } : { cardId, executionId: card.executionId, source: 'human' as const, kind: 'explicit-check' as const, detail: '人工确认验证动作通过', passed }
    if (!record || record.cardId !== cardId || record.executionId !== card.executionId) return
    card.verification = record; card.verificationStatus = record.passed && record.source === 'executor' ? 'passed' : record.passed ? 'failed' : 'failed'; if (card.verificationStatus === 'passed') card.state = 'verified'
    this.addEvent('verification', record.passed && record.source === 'executor' ? `验证证据通过：${record.detail}` : `验证未通过或来源不受控：${record.detail}`, card.id, card.agentId, card.turn, card.step, { evidence: record, controlled: record.source === 'executor' }, record.source === 'executor' ? 'executor' : 'human')
  }
  fail(cardId: string, failureKind: FailureKind, reason: string): void { const card = this.cards.find((item) => item.id === cardId); if (!card) return; card.failureKind = failureKind; if (failureKind !== 'recording-drift') { card.state = 'failed'; card.executionStatus = 'failed'; card.verificationStatus = 'failed'; card.verification = undefined }; this.addEvent('failure', reason, card.id, card.agentId, card.turn, card.step, { failureKind, blocking: failureKind === 'constraint-conflict' }, failureKind === 'recording-drift' ? 'recorder' : 'executor') }
  rewindAndFork(turnBoundary: number, instruction: string): { branchId: string; parentBranchId: string; turnBoundary: number } {
    if (this.mode !== 'rewind-and-fork') throw new Error('rewind-and-fork is not enabled; choose it explicitly when creating the stream')
    if (!Number.isInteger(turnBoundary) || turnBoundary < 0 || (turnBoundary > 0 && !this.completedTurns.has(turnBoundary))) throw new Error('rewind boundary must be a completed turn boundary')
     const parentBranchId = this.activeBranch; const branchId = `branch-${this.branches.size}`; const snapshotId = this.workspace.snapshot({ sessionId: this.sessionId, branchId: parentBranchId, agentId: 'workspace', turn: turnBoundary, step: 0 }); const parent = this.branches.get(parentBranchId); if (parent) parent.active = false; this.branches.set(branchId, { id: branchId, parentId: parentBranchId, forkTurn: turnBoundary, active: true }); this.activeBranch = branchId; this.addConstraint(instruction); this.workspace.fork({ parentBranchId, branchId, turnBoundary, snapshotId }); const metadata = { parentBranchId, branchId, turnBoundary, snapshotId, externalSideEffects: 'not-reversible' }
    this.addEvent('branch-created', `保留原分支 ${parentBranchId}，创建 ${branchId}`, undefined, undefined, turnBoundary, undefined, metadata, 'workspace'); this.addEvent('fork', `从 turn ${turnBoundary} 重做：${instruction}`, undefined, undefined, turnBoundary, undefined, metadata, 'human'); return { branchId, parentBranchId, turnBoundary }
  }
  async redo(cardId: string, action?: ActionInput): Promise<ActionResult> {
    const card = this.cards.find((item) => item.id === cardId); if (!card) throw new Error(`unknown card: ${cardId}`)
    if (this.mode !== 'rewind-and-fork' || this.activeBranch === card.branchId) throw new Error('redo requires a rewind-and-fork child branch')
    return this.execute(action ?? { ...card.action, id: undefined, agentId: card.agentId })
  }
  cancel(): void { if (!this.controller.signal.aborted) this.controller.abort('已被人工叫停') }
  cancelAgent(agentId: string): void { this.agentControllers.get(agentId)?.abort(`Agent ${agentId} 已取消`) }
  cancelTurn(turn: number): void { this.turnControllers.get(turn)?.abort(`turn ${turn} 已取消`) }
  cancelCard(cardId: string): void { const gate = this.gates.get(cardId); if (gate) this.settleCancelled(cardId, '卡片已取消') }
  report(): SessionReport { const decisions = this.cards.filter((card) => card.verdict.kind !== 'gray'); const allowed = this.cards.filter((card) => card.decisionStatus === 'allowed' && card.executionStatus === 'succeeded').length; const overrides = this.cards.filter((card) => card.decisionStatus === 'overridden').length; const runtimeFailures = this.timeline.filter((event) => event.type === 'failure' && event.metadata?.failureKind === 'runtime-error').length; const blockedHelp = this.timeline.filter((event) => event.type === 'failure' && event.metadata?.blockedHelp).length; const corrections = this.timeline.filter((event) => event.type === 'human-adjudication').map((event) => { const card = event.cardId ? this.cards.find((item) => item.id === event.cardId) : undefined; const decision = event.metadata?.decision as HumanDecision | undefined; const after = decision?.kind === 'allow' ? '按原动作执行' : decision && 'text' in decision ? decision.text : decision?.kind ?? '已裁决'; return { cardId: event.cardId ?? '', before: card?.action.description ?? '原动作', after, mode: this.mode } }); return { sessionId: this.sessionId, decisions: decisions.length, allowed, overrides, cancelled: this.cards.filter((card) => card.state === 'cancelled').length, selfDirected: this.timeline.filter((event) => event.type === 'card-created' && event.metadata?.selfDirected).length, recordingDeviations: this.timeline.filter((event) => event.type === 'failure' && event.metadata?.failureKind === 'recording-drift').length, verified: this.cards.filter((card) => card.verificationStatus === 'passed').length, branches: this.branches.size, runtimeFailures, blockedHelp, verificationEvidence: this.cards.filter((card) => card.verification?.source === 'executor').length, irreversibleSideEffects: this.cards.filter((card) => card.externalSideEffect).length, unverified: this.cards.filter((card) => card.executionStatus === 'succeeded' && card.verificationStatus !== 'passed').length, recordingFailures: this.timeline.filter((event) => event.type === 'failure' && event.metadata?.failureKind === 'recording-drift').length, corrections, summary: `本会话记录 ${decisions.length} 个决策，人放行 ${allowed} 个，翻案 ${overrides} 次，验证通过 ${this.cards.filter((card) => card.verificationStatus === 'passed').length} 个。`, events: this.events } }
  private abortRelay(signals: (AbortSignal | undefined)[]): AbortController { const controller = new AbortController(); for (const signal of signals.filter(Boolean) as AbortSignal[]) { if (signal.aborted) controller.abort(signal.reason); else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true }) }; return controller }
  private addEvent(type: TimelineEvent['type'], message: string, cardId?: string, agentId?: string, turn?: number, step?: number, metadata?: Record<string, unknown>, source: TimelineEvent['source'] = 'stream'): void { const sequence = ++this.sequence; const branchId = (cardId && this.cards.find((card) => card.id === cardId)?.branchId) ?? this.activeBranch; const event = { id: `event-${sequence}`, sequence, at: new Date().toISOString(), type, source, sessionId: this.sessionId, branchId, agentId, turn, step, cardId, message, metadata }; this.timeline.push(event); this.persistence?.append(event) }
  private readonly persistence?: EventPersistence
  private restore(events: TimelineEvent[]): void {
    for (const event of events) {
      this.timeline.push(structuredClone(event)); this.sequence = Math.max(this.sequence, event.sequence); this.turn = Math.max(this.turn, event.turn ?? 0); this.step = Math.max(this.step, event.step ?? 0)
      if (event.type === 'agent-registered' && event.agentId) { this.agentIds.add(event.agentId); this.agentControllers.set(event.agentId, new AbortController()) }
      if (event.type === 'human-command' && event.metadata?.spec) this.activeSpec = structuredClone(event.metadata.spec) as ConfirmedSpec
      if (event.type === 'card-created' && event.metadata?.card) this.cards.push(structuredClone(event.metadata.card) as DecisionCard)
      if (event.type === 'branch-created' && event.metadata?.branchId) this.branches.set(String(event.metadata.branchId), { id: String(event.metadata.branchId), parentId: String(event.metadata.parentBranchId), forkTurn: Number(event.metadata.turnBoundary), active: true })
      if (event.type === 'fork' && event.metadata?.branchId) this.activeBranch = String(event.metadata.branchId)
      const card = event.cardId ? this.cards.find((item) => item.id === event.cardId) : undefined
      if (card && event.type === 'human-adjudication' && event.metadata?.decision) { const decision = event.metadata.decision as HumanDecision; card.decisionStatus = decision.kind === 'allow' ? 'allowed' : decision.kind === 'cancel' ? 'cancelled' : 'overridden'; card.state = card.decisionStatus }
       if (event.type === 'injection' && event.metadata?.constraint) this.addConstraint(String(event.metadata.constraint))
      if (card && event.type === 'tool-result') { card.executionStatus = 'succeeded'; card.state = card.decisionStatus === 'overridden' ? 'overridden' : 'allowed' }
      if (card && event.type === 'verification' && event.metadata?.evidence) { card.verification = event.metadata.evidence as VerificationEvidence; card.verificationStatus = card.verification.passed && card.verification.source === 'executor' ? 'passed' : 'failed'; if (card.verificationStatus === 'passed') card.state = 'verified' }
      if (card && event.type === 'failure') { card.state = 'failed'; card.executionStatus = 'failed'; card.failureKind = event.metadata?.failureKind as FailureKind }
      if (event.type === 'turn-end' && event.turn) this.completedTurns.add(event.turn)
    }
    for (const card of this.cards.filter((item) => item.state === 'pending')) { card.state = 'interrupted'; card.decisionStatus = 'interrupted'; card.executionStatus = 'interrupted'; this.addEvent('cancel', '重启后未完成的人审 gate 已标记为 interrupted', card.id, card.agentId, card.turn, card.step, { interrupted: true }, 'stream') }
  }
}
export function cardStateLabel(state: CardState): string { return state === 'verified' ? 'green' : state }
