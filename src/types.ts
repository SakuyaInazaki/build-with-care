import type { RunnerStatus } from './runner-types.js'

export type VerdictKind = 'red' | 'blue' | 'gray'
export type CardState = 'pending' | 'allowed' | 'overridden' | 'cancelled' | 'interrupted' | 'verified' | 'failed'
export type DecisionStatus = 'pending' | 'allowed' | 'overridden' | 'cancelled' | 'interrupted'
export type ExecutionStatus = 'not-started' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export type VerificationStatus = 'unverified' | 'passed' | 'failed'
export type ActionKind = 'write' | 'command' | 'read' | 'validate'
export type CorrectionMode = 'forward-only' | 'rewind-and-fork'
export type FailureKind = 'runtime-error' | 'constraint-conflict' | 'recording-drift'
export type PostHocKind = 'allow' | 'alternative' | 'rewrite'

export interface StructuredConstraint {
  id: string
  domain: string
  kind: 'require' | 'forbid' | 'prefer'
  values: string[]
  text: string
  source: 'spec' | 'adjudication' | 'draft'
  createdAt: string
  affectsFromTurn?: number
}

export interface ConfirmedSpec { id: string; request: string; constraints: string[]; confirmed: boolean; structuredConstraints?: StructuredConstraint[] }

export interface ActionInput {
  id?: string
  tool: string
  kind: ActionKind
  description: string
  args: Record<string, unknown>
  specified?: boolean
  validationPassed?: boolean
  agentId?: string
}

export interface StructuredDecision {
  domain: string
  choice: string
  rationale?: string
  specifiedByHuman?: boolean
  extracted?: boolean
}

export interface WorkUnitInput {
  id?: string
  agentId?: string
  goal: string
  decisions: StructuredDecision[]
  toolCalls: ActionInput[]
  summary?: string
}

export type DecisionMatchOutcome = 'forbidden' | 'required-mismatch' | 'required-match' | 'preference-mismatch' | 'human-specified' | 'unconstrained'
export interface DecisionMatch {
  decision: StructuredDecision
  constraintId?: string
  outcome: DecisionMatchOutcome
  explanation: string
}

export interface UnitToolCall {
  action: ActionInput
  status: 'not-started' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'blocked'
  executionId?: string
  result?: { ok: boolean; output?: unknown; error?: string }
  evidence?: VerificationEvidence
  safetyNet?: { outcome: DecisionMatchOutcome; explanation: string; source: 'policy-safety-net' }
  attempts: number
}

export interface UnitCard {
  goal: string
  decisions: StructuredDecision[]
  matches: DecisionMatch[]
  toolCalls: UnitToolCall[]
  summary?: string
}

export interface ActionIdentity {
  sessionId: string
  branchId: string
  agentId: string
  turn: number
  step: number
}

export interface Verdict { kind: VerdictKind; explanation: string; alternatives: string[]; failureKind?: FailureKind }

export interface VerificationEvidence {
  cardId: string
  executionId: string
  source: 'executor' | 'human' | 'external'
  kind: 'test' | 'build' | 'check' | 'explicit-check'
  detail: string
  passed: boolean
}

/** What the human had said when this step happened. */
export interface HumanContext {
  request: string
  constraints: string[]
  lastAdjudication?: string
}

/** The recorder's reconciliation of "what the human said" vs "what the agent did". */
export interface CardAssessment {
  selfDirected: boolean
  drift: boolean
  confidence: number
  note: string
}

/** Who judged the colour and who kept the record. */
export interface CardProvenance {
  judge: string
  recorder: string
}

/** A human decision taken after the card had already executed. */
export interface PostHocDecision {
  kind: PostHocKind
  text?: string
  at: string
}

export interface DecisionCard extends ActionIdentity {
  id: string
  createdAt: string
  action: ActionInput
  verdict: Verdict
  state: CardState
  decisionStatus: DecisionStatus
  executionStatus: ExecutionStatus
  verificationStatus: VerificationStatus
  appliedConstraint?: string
  verification?: VerificationEvidence
  failureKind?: FailureKind
  executionId?: string
  runtimeAttempts: number
  externalSideEffect: boolean
  approvalDeadline?: string
  blockedHelp?: boolean
  humanContext: HumanContext
  assessment: CardAssessment
  provenance: CardProvenance
  postHocDecision?: PostHocDecision
  unit?: UnitCard
}

export type TimelineEventType =
  | 'session-start' | 'session-end' | 'agent-registered' | 'turn-start' | 'step-start'
  | 'human-command' | 'agent-action' | 'card-created' | 'verdict'
   | 'human-adjudication' | 'injection' | 'tool-call' | 'tool-result' | 'verification' | 'failure'
  | 'branch-created' | 'fork' | 'cancel' | 'turn-end' | 'adapter-event' | 'runner'

export type TimelineEventSource = 'stream' | 'judge' | 'recorder' | 'executor' | 'human' | 'workspace' | 'runner' | 'agent'

export interface TimelineEvent {
  id: string
  sequence: number
  at: string
  type: TimelineEventType
  source: TimelineEventSource
  sessionId: string
  branchId: string
  agentId?: string
  turn?: number
  step?: number
  cardId?: string
  message: string
  provider?: string
  version?: string
  externalType?: string
  metadata?: Record<string, unknown>
}

export interface Branch {
  id: string
  parentId?: string
  forkTurn?: number
  active: boolean
  createdAt?: string
}

export type HumanDecision =
  | { kind: 'allow' }
  | { kind: 'alternative'; text: string }
  | { kind: 'rewrite'; text: string }
  | { kind: 'cancel' }

export interface ToolResult { ok: boolean; output?: unknown; error?: string; executionId: string; cardId: string }

export interface ExecutorInput extends ActionIdentity { cardId: string; executionId: string; action: ActionInput; signal: AbortSignal }
export interface ExecutorResult {
  ok: boolean
  output?: unknown
  error?: string
  verification?: Omit<VerificationEvidence, 'cardId' | 'executionId' | 'source'>
  externalSideEffect?: boolean
}
export interface AgentExecutor { execute(input: ExecutorInput): Promise<ExecutorResult> }

/** Adapter seam for real workspace snapshots. This core never pretends to undo files. */
export interface WorkspaceSnapshotAdapter {
  snapshot(identity: ActionIdentity): string
  fork(input: { parentBranchId: string; branchId: string; turnBoundary: number; snapshotId?: string }): void
}

export interface EventPersistence {
  append(event: TimelineEvent): void
  load(): TimelineEvent[]
}

export interface ActionResult {
  allowed: boolean
  reason?: string
  card: DecisionCard
  branchId?: string
  toolResult?: ToolResult
}

export interface RecorderInput extends ActionIdentity {
  humanInstruction?: string
  constraints?: string[]
  lastAdjudication?: string
  action: ActionInput
}
export interface RecordingAssessment { selfDirected: boolean; deviatesFromInstruction: boolean; note: string; confidence: number; drift: boolean }

export interface VerificationRecord { cardId: string; evidence: VerificationEvidence }

export interface CorrectionRecord {
  cardId: string
  turn: number
  agentId: string
  kind: 'allow' | 'alternative' | 'rewrite' | 'cancel'
  before: string
  after: string
  mode: CorrectionMode
  at: string
  branchId: string
  postHoc: boolean
}

export interface AgentReport {
  agentId: string
  actions: number
  selfDirected: number
  red: number
  blue: number
  gray: number
  verified: number
  failed: number
}

export interface ColorCounts { red: number; blue: number; gray: number; green: number; failed: number }

export interface SessionReport {
  sessionId: string
  startedAt: string
  endedAt?: string
  durationMs: number
  decisions: number
  allowed: number
  overrides: number
  cancelled: number
  selfDirected: number
  recordingDeviations: number
  verified: number
  branches: number
  runtimeFailures: number
  blockedHelp: number
  verificationEvidence: number
  irreversibleSideEffects: number
  unverified: number
  recordingFailures: number
  humanDecisions: number
  agentDecisions: number
  directionCorrections: number
  byColor: ColorCounts
  perAgent: AgentReport[]
  corrections: CorrectionRecord[]
  summary: string
  events: readonly TimelineEvent[]
}

export interface SessionState {
  sessionId: string
  mode: CorrectionMode
  title: string
  createdAt: string
  endedAt?: string
  spec?: ConfirmedSpec
  cards: DecisionCard[]
  timeline: readonly TimelineEvent[]
  branches: readonly Branch[]
  agents: string[]
  runner: RunnerStatus
  report: SessionReport
}

export interface SessionSummary {
  sessionId: string
  mode: CorrectionMode
  title: string
  createdAt: string
  endedAt?: string
  request?: string
  counts: { cards: number; pending: number; red: number; blue: number; gray: number; green: number; failed: number }
  agents: string[]
  runner: RunnerStatus['state']
}
