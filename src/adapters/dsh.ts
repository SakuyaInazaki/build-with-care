import { createRequire } from 'node:module'
import type { ActionIdentity, TimelineEvent } from '../types.js'

export const DSH_PROVIDER = 'deepseek-harness'
export const DSH_TARGET_VERSION = '0.1.3-alpha.1'

export type DshEvent = {
  type: string
  sessionId: string
  sequence: number
  at?: string
  branchId?: string
  agentId?: string
  turn?: number
  step?: number
  source?: string
  provider?: string
  version?: string
  payload?: unknown
}

export type DshPreExecuteInput = ActionIdentity & {
  tool: string
  arguments: Record<string, unknown>
  callId: string
}

export type DshPreExecuteDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }

export type DshInjection = ActionIdentity & { message: string; reason?: string }
export type DshCancel = { sessionId: string; agentId?: string; turn?: number; reason: string }
export type DshFork = { sessionId: string; parentSessionId?: string; turnBoundary: number; instruction: string }

export interface DshAdapter {
  readonly provider: string
  readonly version: string
  onEvent(listener: (event: DshEvent) => void): () => void
  preExecute(input: DshPreExecuteInput): Promise<DshPreExecuteDecision>
  inject(input: DshInjection): Promise<{ accepted: true; delivery: 'next-admitted-request' }>
  cancel(input: DshCancel): Promise<{ accepted: true; aborts: 'pending-and-running' }>
  fork(input: DshFork): Promise<{ childSessionId: string; turnBoundary: number }>
  close(): void
}

export class DshAdapterUnavailableError extends Error {
  constructor(readonly diagnostic: string) {
    super(diagnostic)
    this.name = 'DshAdapterUnavailableError'
  }
}

type DshAvailability = { installed: boolean; version?: string; diagnostic: string }

export function diagnoseDshRuntime(moduleName = '@deepseek-ai/dsh', expectedVersion = DSH_TARGET_VERSION): DshAvailability {
  const require = createRequire(import.meta.url)
  try {
    const packageJson = require(`${moduleName}/package.json`) as { version?: string }
    if (packageJson.version === expectedVersion) return { installed: true, version: packageJson.version, diagnostic: `${moduleName}@${expectedVersion} is installed` }
    return { installed: false, version: packageJson.version, diagnostic: `${moduleName}@${expectedVersion} is required, but ${moduleName}@${packageJson.version ?? 'unknown'} is installed; no real dsh adapter was loaded` }
  } catch {
    return { installed: false, diagnostic: `${moduleName}@${expectedVersion} is not installed; install the pinned dsh runtime separately before enabling a real adapter` }
  }
}

/** Deliberately has no fallback: a missing real runtime must not look connected. */
export function requireRealDshRuntime(moduleName = '@deepseek-ai/dsh', expectedVersion = DSH_TARGET_VERSION): never {
  const availability = diagnoseDshRuntime(moduleName, expectedVersion)
  throw new DshAdapterUnavailableError(`Real dsh adapter unavailable: ${availability.diagnostic}`)
}

const typeMap: Record<string, TimelineEvent['type']> = {
  'session/start': 'session-start',
  'session/end': 'session-end',
  'agent/registered': 'agent-registered',
  'agent/start': 'agent-registered',
  'turn/start': 'turn-start',
  'turn/end': 'turn-end',
  'step/start': 'step-start',
  'tool/call': 'agent-action',
  'tools/pre-execute': 'agent-action',
  'tool/result': 'tool-result',
  'user/message': 'human-command',
  'agent.inject': 'injection',
  'agent.cancel': 'cancel',
  'session/fork': 'fork',
  'branch/created': 'branch-created',
}

function payloadMessage(event: DshEvent, type: TimelineEvent['type']): string {
  if (type === 'injection') return String((event.payload as { message?: unknown } | undefined)?.message ?? 'dsh 注入未来上下文')
  if (type === 'cancel') return String((event.payload as { reason?: unknown } | undefined)?.reason ?? 'dsh 取消当前执行')
  return `${event.provider ?? DSH_PROVIDER} ${event.type}`
}

/** Converts dsh's versioned wire events without losing unknown events or provenance. */
export function mapDshEvent(event: DshEvent): TimelineEvent {
  const type = typeMap[event.type] ?? 'adapter-event'
  return {
    id: `dsh-event-${event.sequence}`,
    sequence: event.sequence,
    at: event.at ?? new Date().toISOString(),
    type,
    source: 'stream',
    provider: event.provider ?? DSH_PROVIDER,
    version: event.version,
    externalType: event.type,
    sessionId: event.sessionId,
    branchId: event.branchId ?? 'main',
    agentId: event.agentId,
    turn: event.turn,
    step: event.step,
    message: payloadMessage(event, type),
    metadata: { dshPayload: event.payload, dshSource: event.source ?? 'session.event' },
  }
}

type PendingGate = { input: DshPreExecuteInput; resolve: (decision: DshPreExecuteDecision) => void; reject: (error: Error) => void }

/** In-memory contract test double; it never executes a tool or claims to be dsh. */
export class MockDshAdapter implements DshAdapter {
  readonly provider = 'mock-dsh'
  readonly version = 'mock-1'
  readonly events: DshEvent[] = []
  readonly injected: DshInjection[] = []
  readonly pending = new Map<string, PendingGate>()
  private readonly listeners = new Set<(event: DshEvent) => void>()
  private readonly completedTurns = new Set<number>()
  private sequence = 0
  private closed = false

  start(sessionId: string): void { this.emit({ type: 'session/start', sessionId }) }
  completeTurn(identity: Pick<ActionIdentity, 'sessionId' | 'turn' | 'agentId' | 'branchId'>): void { this.completedTurns.add(identity.turn); this.emit({ type: 'turn/end', ...identity }) }
  onEvent(listener: (event: DshEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  async preExecute(input: DshPreExecuteInput): Promise<DshPreExecuteDecision> {
    if (this.closed) throw new Error('mock dsh adapter is closed')
    this.emit({ type: 'tools/pre-execute', ...input, payload: { tool: input.tool, arguments: input.arguments } })
    return new Promise((resolve, reject) => this.pending.set(input.callId, { input, resolve, reject }))
  }
  allow(callId: string): void { this.settle(callId, { kind: 'allow' }) }
  deny(callId: string, reason: string): void { if (!reason.trim()) throw new Error('deny reason is required'); this.settle(callId, { kind: 'deny', reason }) }
  async inject(input: DshInjection): Promise<{ accepted: true; delivery: 'next-admitted-request' }> {
    if (this.closed) throw new Error('mock dsh adapter is closed')
    this.injected.push(structuredClone(input)); this.emit({ type: 'agent.inject', ...input, payload: { message: input.message, delivery: 'next-admitted-request', affects: 'future-only' } }); return { accepted: true, delivery: 'next-admitted-request' }
  }
  async cancel(input: DshCancel): Promise<{ accepted: true; aborts: 'pending-and-running' }> {
    for (const [callId, gate] of this.pending) if (gate.input.sessionId === input.sessionId && (!input.agentId || gate.input.agentId === input.agentId) && (input.turn === undefined || gate.input.turn === input.turn)) { gate.resolve({ kind: 'deny', reason: input.reason }); this.pending.delete(callId) }
    this.emit({ type: 'agent.cancel', sessionId: input.sessionId, agentId: input.agentId, turn: input.turn, payload: { reason: input.reason } }); return { accepted: true, aborts: 'pending-and-running' }
  }
  async fork(input: DshFork): Promise<{ childSessionId: string; turnBoundary: number }> {
    if (input.turnBoundary > 0 && !this.completedTurns.has(input.turnBoundary)) throw new Error('dsh fork requires a completed turn boundary')
    const childSessionId = `${input.sessionId}:fork:${input.turnBoundary}`; this.emit({ type: 'session/fork', sessionId: childSessionId, payload: { parentSessionId: input.parentSessionId ?? input.sessionId, turnBoundary: input.turnBoundary, instruction: input.instruction } }); return { childSessionId, turnBoundary: input.turnBoundary }
  }
  close(): void { this.closed = true; for (const gate of this.pending.values()) gate.reject(new Error('mock dsh adapter closed')); this.pending.clear(); this.listeners.clear() }
  private settle(callId: string, decision: DshPreExecuteDecision): void { const gate = this.pending.get(callId); if (!gate) throw new Error(`unknown pending dsh call: ${callId}`); this.pending.delete(callId); gate.resolve(decision); this.emit({ type: decision.kind === 'allow' ? 'tools/pre-execute/allow' : 'tools/pre-execute/deny', ...gate.input, payload: decision }) }
  private emit(event: Omit<DshEvent, 'sequence'>): void { const full = { ...event, sequence: ++this.sequence, provider: this.provider, version: this.version }; this.events.push(full); for (const listener of this.listeners) listener(full) }
}
