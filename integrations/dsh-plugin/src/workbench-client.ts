/**
 * Thin HTTP client for the Decision Stream workbench (docs/api-contract-v2.md).
 * Only the routes the bridge needs. Uses global `fetch` (Node >= 18).
 */
import { DSH_TARGET_VERSION, type ActionInput, type CardLike, type TimelineEventLike, type WorkUnitInput } from './mapping.js'

export interface SpecInput { id: string; request: string; constraints: string[]; confirmed: true }

export interface SessionStateLike {
  sessionId: string
  mode: string
  spec?: { id: string; request: string; constraints: string[]; confirmed: boolean }
  cards: CardLike[]
  timeline: TimelineEventLike[]
  endedAt?: string
}

export class WorkbenchError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'WorkbenchError'
  }
}

export interface WorkbenchClientOptions {
  fetch?: typeof fetch
  /** Per-request timeout; the gate itself is unbounded (fail-closed on the workbench side). */
  requestTimeoutMs?: number
}

export interface ToolResultInput {
  unitId: string
  callId: string
  tool: string
  ok: boolean
  output?: unknown
  error?: string
  evidence?: unknown
  externalSideEffect?: boolean
}

export class WorkbenchClient {
  private readonly fetchImpl: typeof fetch
  private readonly requestTimeoutMs: number
  readonly baseUrl: string

  constructor(baseUrl: string, options: WorkbenchClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.fetchImpl = options.fetch ?? fetch
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000
  }

  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<{ status: number; value: T }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('workbench request timeout')), this.requestTimeoutMs)
    const onAbort = (): void => controller.abort(signal?.reason)
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }) }
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await response.text()
      let value: unknown = undefined
      try { value = text ? JSON.parse(text) : undefined } catch { value = text }
      if (!response.ok) {
        const error = (value as { error?: { code?: string; message?: string } } | undefined)?.error
        throw new WorkbenchError(response.status, error?.code ?? 'http_error', error?.message ?? `HTTP ${response.status} ${path}`)
      }
      return { status: response.status, value: value as T }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async createSession(mode: 'forward-only' | 'rewind-and-fork', title?: string): Promise<SessionStateLike> {
    return (await this.request<SessionStateLike>('POST', '/api/sessions', { mode, ...(title ? { title } : {}) })).value
  }

  async getState(sessionId: string, signal?: AbortSignal): Promise<SessionStateLike> {
    return (await this.request<SessionStateLike>('GET', `/api/sessions/${encodeURIComponent(sessionId)}/state`, undefined, signal)).value
  }

  async confirmSpec(sessionId: string, spec: SpecInput): Promise<SessionStateLike> {
    return (await this.request<SessionStateLike>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/spec`, spec)).value
  }

  /** 202 + state (judging may be async; poll `getState` afterwards). */
  async postAction(sessionId: string, action: ActionInput, signal?: AbortSignal): Promise<SessionStateLike> {
    return (await this.request<SessionStateLike>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/actions`, action, signal)).value
  }

  /** Post one aggregated work unit. A missing route is a configuration error, not a fallback signal. */
  async postUnit(sessionId: string, unit: WorkUnitInput, signal?: AbortSignal): Promise<SessionStateLike> {
    return (await this.request<SessionStateLike>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/units`, unit, signal)).value
  }

  /** Write the final dsh tool outcome to the adapter event stream. */
  async postToolResult(sessionId: string, result: ToolResultInput): Promise<boolean> {
    return this.postAdapterEvent(sessionId, {
      type: 'tool-result', sessionId, source: 'tool-result', provider: 'deepseek-harness', version: DSH_TARGET_VERSION, payload: result,
    })
  }

  async cancelCard(sessionId: string, cardId: string): Promise<void> {
    await this.request('POST', `/api/sessions/${encodeURIComponent(sessionId)}/cards/${encodeURIComponent(cardId)}/cancel`, {})
  }

  async timeline(sessionId: string, query: { eventType?: string; since?: number } = {}, signal?: AbortSignal): Promise<TimelineEventLike[]> {
    const params = new URLSearchParams()
    if (query.eventType) params.set('eventType', query.eventType)
    if (query.since !== undefined) params.set('since', String(query.since))
    const suffix = params.size ? `?${params.toString()}` : ''
    const events = (await this.request<TimelineEventLike[]>('GET', `/api/sessions/${encodeURIComponent(sessionId)}/timeline${suffix}`, undefined, signal)).value
    // `since` is contract v2; the current backend ignores it, so filter client-side too.
    return query.since === undefined ? events : events.filter((event) => event.sequence > query.since!)
  }

  /**
   * Forward one dsh session event as an `adapter-event`. The route is optional
   * for older workbench deployments; returns `false` on 404 so the caller can stop trying.
   */
  async postAdapterEvent(sessionId: string, event: unknown): Promise<boolean> {
    try {
      await this.request('POST', `/api/sessions/${encodeURIComponent(sessionId)}/adapter-events`, event)
      return true
    } catch (error) {
      if (error instanceof WorkbenchError && error.status === 404) return false
      throw error
    }
  }
}

export function findCard(state: SessionStateLike | undefined, cardId: string): CardLike | undefined {
  return state?.cards.find((card) => card.id === cardId)
}
