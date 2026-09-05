export type Mode = 'demo' | 'live'
export type RunStatus =
  | 'ready'
  | 'running'
  | 'waiting'
  | 'stopping'
  | 'stopped'
  | 'completed'
  | 'error'
  | 'interrupted'
export type Classification = 'execution' | 'choice' | 'conflict' | 'uncertain'
export interface Constraint {
  id: string
  text: string
  source: string
  revision: number
  active: boolean
}
export interface Review {
  classification: Classification
  title: string
  summary: string
  impact: string
  constraintIds: string[]
  evidence: string
  options: string[]
  topic: string
  source: 'demo-rule' | 'independent-model' | 'system'
}
export interface Step {
  id: string
  callId: string
  tool: string
  args: Record<string, unknown>
  revision: number
  createdAt: string
  finishedAt?: string
  status: 'reviewing' | 'waiting' | 'executing' | 'done' | 'denied' | 'failed' | 'cancelled'
  review?: Review
  result?: string
  decisionId?: string
  artifactChanged?: boolean
}
export interface Decision {
  id: string
  stepIds: string[]
  review: Review
  revision: number
  createdAt: string
  humanStatus: 'unreviewed' | 'acknowledged' | 'corrected' | 'allowed-once'
  executionStatus: Step['status']
  gateId?: string
}
export interface Gate {
  id: string
  stepId: string
  decisionId: string
  revision: number
  argsHash: string
  status: 'pending' | 'allowed' | 'denied' | 'cancelled' | 'expired'
  expiresAt: string
}
export interface Intervention {
  id: string
  requestId: string
  decisionId?: string
  stepId?: string
  action: 'correct' | 'enforce' | 'allow-once' | 'acknowledge' | 'stop' | 'followup'
  additionKind?: 'requirement' | 'idea'
  text: string
  fromRevision: number
  toRevision: number
  createdAt: string
  progress: 'recorded' | 'delivered' | 'acted' | 'verified'
  subsequentStepIds: string[]
}
export interface AdditionInput {
  requestId: string
  revision: number
  kind: 'requirement' | 'idea'
  text: string
  replaceConstraintId?: string
}
export interface Verification {
  id: string
  stepId: string
  path: string
  artifactHash: string
  name: string
  passed: boolean
  stale: boolean
  detail: string
  createdAt: string
}
export interface AppEvent {
  id: string
  seq: number
  runId: string
  type: string
  at: string
  data: unknown
}
export interface RunState {
  id: string
  title: string
  prompt: string
  mode: Mode
  status: RunStatus
  createdAt: string
  updatedAt: string
  revision: number
  constraints: Constraint[]
  steps: Step[]
  decisions: Decision[]
  gates: Gate[]
  interventions: Intervention[]
  verifications: Verification[]
  messages: { id: string; role: 'agent' | 'system'; text: string; at: string }[]
  files: { path: string; hash: string; bytes: number }[]
  reflection: string
  lastEventSeq: number
  error?: string
  runtime: string
  workerLabel: string
  reviewerLabel: string
  grill?: GrillState
}
export interface GrillQuestion {
  title: string
  reason: string
  options: string[]
}
export interface GrillState {
  status: 'idle' | 'question' | 'confirm' | 'confirmed'
  round: number
  question?: GrillQuestion
  answers: { question: string; answer: string }[]
  constraints: string[]
  assumptions: string[]
  unresolved: string[]
}
export interface GrillConfirmation {
  confirmed: boolean
  acceptedAssumptions: boolean
  unresolved: { item: string; answer: string }[]
}
export interface ModelConfig {
  baseUrl: string
  model: string
  family: string
  apiKey: string
  reasoningEffort?: 'none' | 'low' | 'high' | 'max'
}
export interface Settings {
  worker: ModelConfig
  reviewer: ModelConfig
  reviewTimeoutMs: number
  gateTimeoutMs: number
  demoDelayMs: number
}
export interface PublicSettings {
  worker: Omit<ModelConfig, 'apiKey'> & { hasKey: boolean }
  reviewer: Omit<ModelConfig, 'apiKey'> & { hasKey: boolean }
  reviewTimeoutMs: number
  gateTimeoutMs: number
  configured: boolean
  sharedDeepSeekKey?: boolean
}
export interface VerdictInput {
  requestId: string
  revision: number
  decisionId: string
  gateId?: string
  action: 'correct' | 'enforce' | 'allow-once' | 'acknowledge'
  text?: string
  replaceConstraintId?: string
}
export const DEMO_PROMPT =
  '做一个中文活动报名页，不用登录，不连接外部服务。刷新页面后清空报名信息。'
export const STATUS_LABELS: Record<RunStatus, string> = {
  ready: '准备开始',
  running: '正在推进',
  waiting: '等你拍板',
  stopping: '正在停止',
  stopped: '已停止',
  completed: '本轮已完成',
  error: '运行遇到问题',
  interrupted: '运行已中断',
}
