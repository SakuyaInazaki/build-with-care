export type VerdictKind = 'red' | 'blue' | 'gray'
export type CardState = 'pending' | 'allowed' | 'overridden' | 'cancelled' | 'interrupted' | 'verified' | 'failed'
export type DecisionStatus = 'pending' | 'allowed' | 'overridden' | 'cancelled' | 'interrupted'
export type ExecutionStatus = 'not-started' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export type VerificationStatus = 'unverified' | 'passed' | 'failed'
export type ActionKind = 'write' | 'command' | 'read' | 'validate'
export type CorrectionMode = 'forward-only' | 'rewind-and-fork'
export type FailureKind = 'runtime-error' | 'constraint-conflict' | 'recording-drift'

export interface ConfirmedSpec { id: string; request: string; constraints: string[]; confirmed: boolean }

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
}

export type TimelineEventType =
  | 'session-start' | 'session-end' | 'agent-registered' | 'turn-start' | 'step-start'
  | 'human-command' | 'agent-action' | 'card-created' | 'verdict'
  | 'human-adjudication' | 'injection' | 'tool-result' | 'verification' | 'failure'
  | 'branch-created' | 'fork' | 'cancel' | 'turn-end' | 'adapter-event'

export interface TimelineEvent {
  id: string
  sequence: number
  at: string
  type: TimelineEventType
  source: 'stream' | 'judge' | 'recorder' | 'executor' | 'human' | 'workspace'
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

export interface RecorderInput extends ActionIdentity { humanInstruction?: string; action: ActionInput }
export interface RecordingAssessment { selfDirected: boolean; deviatesFromInstruction: boolean; note: string; confidence: number; drift: boolean }

export interface VerificationRecord { cardId: string; evidence: VerificationEvidence }

export interface SessionReport {
  sessionId: string
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
  corrections: Array<{ cardId: string; before: string; after: string; mode: CorrectionMode }>
  summary: string
  events: readonly TimelineEvent[]
}
