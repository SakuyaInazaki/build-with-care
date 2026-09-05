/**
 * Shared runner contract. A runner is whatever drives a session on the server side:
 * the scripted demo (`demo`) or a real model agent loop (`llm`).
 * Both the backend line and the LLM line implement this; the HTTP layer only talks to this interface.
 */
export type RunnerKind = 'idle' | 'demo' | 'llm'
export type RunnerState = 'idle' | 'running' | 'waiting-human' | 'done' | 'failed' | 'cancelled'
export type DemoScenario = 'full' | 'multi-agent' | 'red-only'

export interface RunnerStage { id: string; label: string; status: 'pending' | 'active' | 'done' | 'skipped' | 'failed' }

export interface RunnerStatus {
  kind: RunnerKind
  state: RunnerState
  scenario?: DemoScenario
  stages?: RunnerStage[]
  message?: string
  waitingCardId?: string
  model?: string
  steps?: number
  startedAt?: string
  finishedAt?: string
}

export const idleRunnerStatus = (): RunnerStatus => ({ kind: 'idle', state: 'idle' })

export interface Runner {
  readonly status: RunnerStatus
  /** Listener fires on every status change; returns an unsubscribe. */
  subscribe(listener: (status: RunnerStatus) => void): () => void
  /** Resolves when the run finishes (done / failed / cancelled). Must never reject for expected outcomes. */
  start(): Promise<void>
  cancel(reason?: string): void
}
