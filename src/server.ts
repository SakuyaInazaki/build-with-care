import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DecisionStream, DecisionStreamError, LocalAgentExecutor, approvalTimeoutFromEnv } from './stream.js'
import { JsonlEventPersistence } from './persistence.js'
import { DemoRunner, DEMO_SCENARIOS } from './demo-runner.js'
import { SseConnection } from './sse.js'
import { diagnoseDshRuntime } from './adapters/dsh.js'
import { idleRunnerStatus, type DemoScenario, type Runner, type RunnerStatus } from './runner-types.js'
import type { ActionInput, ConfirmedSpec, CorrectionMode, HumanDecision, SessionState, SessionSummary, StructuredConstraint, WorkUnitInput } from './types.js'
import { structureConstraint } from './work-unit.js'
import { createLlmJudge, createLlmRecorder } from './llm/judge.js'
import { loadLlmConfig, describeLlmConfig } from './llm/config.js'
import { createLlmRunner as createConfiguredLlmRunner } from './llm/agent-runner.js'

export const API_VERSION = '0.2.0'

const publicRoot = resolve(join(fileURLToPath(new URL('.', import.meta.url)), 'public'))
const defaultDataRoot = resolve(process.env.DECISION_STREAM_DATA ?? join(process.cwd(), '.decision-stream'))
const maxBodyBytes = 1024 * 1024
const sessionIdPattern = /^[A-Za-z0-9_-]{1,80}$/
const cardIdPattern = /^[A-Za-z0-9_.:-]{1,120}$/
const actionKinds = new Set(['write', 'read', 'command', 'validate'])
const decisionKinds = new Set(['allow', 'alternative', 'rewrite', 'cancel'])
const correctionModes = new Set<CorrectionMode>(['forward-only', 'rewind-and-fork'])

/** Optional modules other lines may add. Loaded lazily and guarded so their absence is a feature, not an error. */
const LLM_CONFIG_MODULE = './llm/config.js'
const LLM_SPEC_DRAFT_MODULE = './llm/spec-draft.js'
const LLM_AGENT_RUNNER_MODULE = './llm/agent-runner.js'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json; charset=utf-8',
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}
const bad = (message: string) => new ApiError(400, 'invalid_request', message)
const missing = (message: string) => new ApiError(404, 'not_found', message)
const conflict = (message: string, code = 'conflict') => new ApiError(409, code, message)
const invalid = (message: string) => new ApiError(422, 'unprocessable_entity', message)

// ---------------------------------------------------------------------------
// Request parsing / validation
// ---------------------------------------------------------------------------

function assertSessionId(value: string): void {
  if (!sessionIdPattern.test(value)) throw bad('invalid sessionId')
}

function object(value: unknown, label = 'JSON body'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad(`${label} must be an object`)
  return value as Record<string, unknown>
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const length = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(length) && length > maxBodyBytes) throw new ApiError(413, 'body_too_large', 'request body exceeds 1 MiB')
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > maxBodyBytes) throw new ApiError(413, 'body_too_large', 'request body exceeds 1 MiB')
    chunks.push(buffer)
  }
  if (!size) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw bad('malformed JSON')
  }
  return object(parsed)
}

function parseAction(value: Record<string, unknown>): ActionInput {
  if (typeof value.tool !== 'string' || !value.tool.trim()) throw bad('action.tool must be a non-empty string')
  if (typeof value.kind !== 'string' || !actionKinds.has(value.kind)) throw bad(`action.kind must be one of ${[...actionKinds].join(', ')}`)
  if (typeof value.description !== 'string' || !value.description.trim()) throw bad('action.description must be a non-empty string')
  if (!value.args || typeof value.args !== 'object' || Array.isArray(value.args)) throw bad('action.args must be an object')
  if (value.id !== undefined && (typeof value.id !== 'string' || !cardIdPattern.test(value.id))) throw bad('action.id must be a short identifier')
  if (value.agentId !== undefined && (typeof value.agentId !== 'string' || !value.agentId.trim())) throw bad('action.agentId must be a non-empty string')
  if (value.specified !== undefined && typeof value.specified !== 'boolean') throw bad('action.specified must be a boolean')
  return {
    id: value.id as string | undefined,
    tool: value.tool,
    kind: value.kind as ActionInput['kind'],
    description: value.description,
    args: { ...(value.args as Record<string, unknown>) },
    specified: value.specified as boolean | undefined,
    agentId: value.agentId as string | undefined,
  }
}

function parseSpec(value: Record<string, unknown>): ConfirmedSpec {
  if (typeof value.id !== 'string' || typeof value.request !== 'string' || value.confirmed !== true || (value.constraints !== undefined && !Array.isArray(value.constraints)) || (value.structuredConstraints === undefined && value.constraints === undefined)) {
    throw bad('spec requires id, request, constraints[] and/or structuredConstraints[], and confirmed=true')
  }
  if (Array.isArray(value.constraints) && value.constraints.some((item) => typeof item !== 'string')) throw bad('spec constraints must be strings')
  const constraints = (value.constraints as string[] | undefined) ?? ((value.structuredConstraints as Array<{ text?: unknown }>).map((item) => typeof item.text === 'string' ? item.text : '').filter(Boolean))
  if (value.structuredConstraints !== undefined && (!Array.isArray(value.structuredConstraints) || value.structuredConstraints.some((item) => !item || typeof item !== 'object'))) throw bad('spec structuredConstraints must be objects')
  const structuredConstraints = (value.structuredConstraints as StructuredConstraint[] | undefined)?.map((item, index) => ({ ...item, id: item.id || `spec-${index + 1}`, source: 'spec' as const, createdAt: item.createdAt ?? new Date().toISOString() }))
    ?? constraints.flatMap((text, index) => structureConstraint(text, { id: `spec-${index + 1}`, source: 'spec' }))
  return { id: value.id, request: value.request, constraints, confirmed: true, structuredConstraints }
}

function parseUnit(value: Record<string, unknown>): WorkUnitInput {
  if (typeof value.goal !== 'string' || !value.goal.trim() || !Array.isArray(value.decisions) || !Array.isArray(value.toolCalls)) throw bad('unit requires goal, decisions[] and toolCalls[]')
  return { id: value.id as string | undefined, agentId: value.agentId as string | undefined, goal: value.goal.trim(), decisions: value.decisions as WorkUnitInput['decisions'], toolCalls: (value.toolCalls as Record<string, unknown>[]).map(parseAction), summary: value.summary as string | undefined }
}

function parseDecision(value: Record<string, unknown>): HumanDecision {
  if (typeof value.kind !== 'string' || !decisionKinds.has(value.kind)) throw bad('invalid decision kind')
  if (value.kind === 'allow' || value.kind === 'cancel') return { kind: value.kind }
  if (typeof value.text !== 'string' || !value.text.trim()) throw bad('decision text is required')
  return { kind: value.kind as 'alternative' | 'rewrite', text: value.text.trim() }
}

function parseMode(value: unknown): CorrectionMode {
  if (value === undefined) return 'forward-only'
  if (typeof value !== 'string' || !correctionModes.has(value as CorrectionMode)) throw bad('invalid correction mode')
  return value as CorrectionMode
}

function parseScenario(value: unknown): DemoScenario {
  if (value === undefined) return 'full'
  if (typeof value !== 'string' || !DEMO_SCENARIOS.includes(value as DemoScenario)) throw bad(`scenario must be one of ${DEMO_SCENARIOS.join(', ')}`)
  return value as DemoScenario
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(value))
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  if (error instanceof DecisionStreamError) return new ApiError(error.status, error.code, error.message)
  if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return missing('resource not found')
  if (error instanceof Error && /duplicate|conflicting|not enabled|boundary/.test(error.message)) return conflict(error.message)
  return new ApiError(500, 'internal_error', error instanceof Error ? error.message : String(error))
}

// ---------------------------------------------------------------------------
// Spec drafting (template fallback; the LLM line can plug in `draftSpecWithLlm`)
// ---------------------------------------------------------------------------

const DRAFT_RULES: Array<{ pattern: RegExp; constraint: string }> = [
  { pattern: /数据库|存储|保存|持久|database|storage|store|persist/i, constraint: '存储方案须由人确认，未确认前不得自行选型' },
  { pattern: /登录|注册|账号|鉴权|auth|login|sign/i, constraint: '是否需要登录以及鉴权方式须由人确认' },
  { pattern: /前端|页面|界面|网页|ui|frontend/i, constraint: '前端框架与页面结构须由人确认' },
  { pattern: /部署|上线|发布|deploy|release/i, constraint: '部署与对外发布动作必须由人放行' },
  { pattern: /邮件|通知|支付|短信|email|payment|sms|notify/i, constraint: '任何外部副作用（邮件、支付、通知）必须由人放行' },
  { pattern: /删除|清空|迁移|migrat|drop|delete/i, constraint: '删除或迁移已有数据前必须由人确认' },
]

export function draftSpecTemplate(request: string): string[] {
  const constraints = DRAFT_RULES.filter((rule) => rule.pattern.test(request)).map((rule) => rule.constraint).slice(0, 3)
  constraints.push('核心流程必须可验证')
  if (constraints.length < 2) constraints.unshift('实现范围以这句话需求为准，超出部分须由人确认')
  return constraints.slice(0, 4)
}

type LlmSection = { configured: boolean; provider: string | null; model: string | null }
type LlmConfig = { agent: LlmSection; judge: LlmSection; recorder: LlmSection }

async function optionalModule(specifier: string): Promise<Record<string, unknown> | undefined> {
  try {
    return (await import(specifier)) as Record<string, unknown>
  } catch {
    return undefined
  }
}

async function describeLlm(): Promise<LlmConfig> {
  const none: LlmSection = { configured: false, provider: null, model: null }
  const fallback: LlmConfig = { agent: { ...none }, judge: { ...none }, recorder: { ...none } }
  const module = await optionalModule(LLM_CONFIG_MODULE)
  if (typeof module?.describeLlmConfig !== 'function') return fallback
  try {
    const described = await (module.describeLlmConfig as () => Promise<Partial<LlmConfig>> | Partial<LlmConfig>)()
    return { ...fallback, ...described }
  } catch {
    return fallback
  }
}

async function draftSpec(request: string): Promise<{ request: string; constraints: string[]; source: 'llm' | 'template' }> {
  const module = await optionalModule(LLM_SPEC_DRAFT_MODULE)
  if (typeof module?.draftSpecWithLlm === 'function') {
    try {
      const drafted = await (module.draftSpecWithLlm as (request: string) => Promise<{ constraints: string[]; source: 'llm' | 'template' } | null>)(request)
      if (drafted && Array.isArray(drafted.constraints) && drafted.constraints.length) return { request, constraints: drafted.constraints, source: drafted.source ?? 'llm' }
    } catch {
      // fall through to the template
    }
  }
  return { request, constraints: draftSpecTemplate(request), source: 'template' }
}

/**
 * Expected LLM runner module (built by the LLM line against `src/runner-types.ts`):
 *
 *   export function createLlmRunner(
 *     stream: DecisionStream,
 *     options: { request?: string; maxSteps?: number; workspaceRoot: string },
 *   ): Runner | Promise<Runner>
 *
 * It must throw when no model is configured; any thrown error is reported as 409 `llm_not_configured`.
 */
async function createLlmRunner(stream: DecisionStream, options: { request?: string; maxSteps?: number; workspaceRoot: string }): Promise<Runner> {
  const module = await optionalModule(LLM_AGENT_RUNNER_MODULE)
  if (typeof module?.createLlmRunner !== 'function') throw conflict('no LLM agent runner is configured; set up src/llm/agent-runner.ts', 'llm_not_configured')
  try {
    return await (module.createLlmRunner as (stream: DecisionStream, options: unknown) => Runner | Promise<Runner>)(stream, options)
  } catch (error) {
    throw conflict(error instanceof Error ? error.message : 'LLM runner is not configured', 'llm_not_configured')
  }
}

// ---------------------------------------------------------------------------
// Session: a stream plus whatever runner is driving it
// ---------------------------------------------------------------------------

class Session {
  runner?: Runner
  runnerStatus: RunnerStatus = idleRunnerStatus()
  private readonly runnerListeners = new Set<(status: RunnerStatus) => void>()
  private unsubscribeRunner?: () => void

  constructor(readonly stream: DecisionStream, readonly workspaceRoot: string) {}

  get busy(): boolean { return this.runnerStatus.state === 'running' || this.runnerStatus.state === 'waiting-human' }

  onRunnerStatus(listener: (status: RunnerStatus) => void): () => void {
    this.runnerListeners.add(listener)
    return () => { this.runnerListeners.delete(listener) }
  }

  /** Starts a runner in the background; only one may be running per session. */
  attach(runner: Runner): void {
    if (this.busy) throw conflict('a runner is already driving this session', 'runner_busy')
    this.unsubscribeRunner?.()
    this.runner = runner
    this.setRunnerStatus(runner.status)
    this.unsubscribeRunner = runner.subscribe((status) => this.setRunnerStatus(status))
    void runner.start().catch((error: unknown) => {
      this.setRunnerStatus({ ...this.runnerStatus, state: 'failed', finishedAt: new Date().toISOString(), message: error instanceof Error ? error.message : String(error) })
    })
  }

  cancelRunner(reason: string): void {
    if (this.busy) this.runner?.cancel(reason)
  }

  private setRunnerStatus(status: RunnerStatus): void {
    this.runnerStatus = { ...status, stages: status.stages?.map((stage) => ({ ...stage })) }
    for (const listener of this.runnerListeners) {
      try { listener(this.runnerStatus) } catch { /* subscribers must not break the session */ }
    }
  }
}

function sessionState(session: Session): SessionState {
  const { stream } = session
  return {
    sessionId: stream.sessionId,
    mode: stream.mode,
    title: stream.title,
    createdAt: stream.createdAt,
    endedAt: stream.endedAt,
    spec: stream.spec,
    cards: stream.cards,
    timeline: stream.events,
    branches: stream.branchList,
    agents: stream.agents,
    runner: session.runnerStatus,
    report: stream.report(),
  }
}

function sessionUpdate(session: Session): Pick<SessionState, 'cards' | 'branches' | 'spec' | 'report' | 'runner' | 'endedAt' | 'agents'> {
  const { stream } = session
  return { cards: stream.cards, branches: stream.branchList, spec: stream.spec, report: stream.report(), runner: session.runnerStatus, endedAt: stream.endedAt, agents: stream.agents }
}

function sessionSummary(session: Session): SessionSummary {
  const { stream } = session
  const cards = stream.cards
  return {
    sessionId: stream.sessionId,
    mode: stream.mode,
    title: stream.title,
    createdAt: stream.createdAt,
    endedAt: stream.endedAt,
    request: stream.spec?.request,
    counts: {
      cards: cards.length,
      pending: cards.filter((card) => card.state === 'pending').length,
      red: cards.filter((card) => card.verdict.kind === 'red').length,
      blue: cards.filter((card) => card.verdict.kind === 'blue').length,
      gray: cards.filter((card) => card.verdict.kind === 'gray').length,
      green: cards.filter((card) => card.state === 'verified').length,
      failed: cards.filter((card) => card.state === 'failed').length,
    },
    agents: stream.agents,
    runner: session.runnerStatus.state,
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface DecisionServerOptions {
  dataRoot?: string
  approvalTimeoutMs?: number
  /** SSE keep-alive interval; tests shorten it. */
  ssePingMs?: number
}

export interface DecisionServer {
  server: Server
  sessions: Map<string, Session>
  dataRoot: string
  createSession(mode?: CorrectionMode, title?: string): Session
  /** Closes SSE connections and the listener; resolves once the server has stopped. */
  close(): Promise<void>
}

export function createDecisionServer(options: DecisionServerOptions = {}): DecisionServer {
  const dataRoot = resolve(options.dataRoot ?? defaultDataRoot)
  const workspacesRoot = join(dataRoot, 'workspaces')
  const approvalTimeoutMs = options.approvalTimeoutMs ?? approvalTimeoutFromEnv()
  mkdirSync(dataRoot, { recursive: true })
  const sessions = new Map<string, Session>()
  const connections = new Set<SseConnection>()

  const workspaceFor = (id: string): string => join(workspacesRoot, id)

  const streamOptions = (id: string, extra: Record<string, unknown> = {}) => {
    const config = loadLlmConfig()
    return { sessionId: id, executor: new LocalAgentExecutor(workspaceFor(id)), approvalTimeoutMs, judge: createLlmJudge({ config }) ?? undefined, recorder: createLlmRecorder({ config }) ?? undefined, ...extra }
  }

  for (const file of readdirSync(dataRoot).filter((name) => name.endsWith('.jsonl'))) {
    const id = basename(file, '.jsonl')
    if (!sessionIdPattern.test(id)) continue
    const persistence = new JsonlEventPersistence(join(dataRoot, file))
    const events = persistence.load()
    if (events[0]?.sessionId !== id) continue
    const stream = new DecisionStream({ ...streamOptions(id), persistence, restoredEvents: events })
    sessions.set(id, new Session(stream, workspaceFor(id)))
  }

  const getSession = (id: string): Session => {
    assertSessionId(id)
    const session = sessions.get(id)
    if (!session) throw missing(`session ${id} not found`)
    return session
  }

  const createSession = (mode: CorrectionMode = 'forward-only', title?: string): Session => {
    if (!correctionModes.has(mode)) throw bad('invalid correction mode')
    const id = `session-${randomUUID()}`
    const persistence = new JsonlEventPersistence(join(dataRoot, `${id}.jsonl`))
    const stream = new DecisionStream({ ...streamOptions(id), mode, title, persistence })
    const session = new Session(stream, workspaceFor(id))
    sessions.set(id, session)
    return session
  }

  const activeSession = (session: Session): Session => {
    if (session.stream.ended) throw conflict(`session ${session.stream.sessionId} has ended`, 'session_ended')
    return session
  }

  const findCard = (session: Session, cardId: string | undefined) => {
    const card = session.stream.cards.find((item) => item.id === cardId)
    if (!card) throw missing(`card ${cardId ?? ''} not found`)
    return card
  }

  const openEvents = (request: IncomingMessage, response: ServerResponse, session: Session): void => {
    const connection = new SseConnection(request, response, { pingMs: options.ssePingMs })
    connections.add(connection)
    connection.send('state', sessionState(session))
    let scheduled = false
    const scheduleUpdate = () => {
      if (scheduled) return
      scheduled = true
      setImmediate(() => {
        scheduled = false
        if (connection.isOpen) connection.send('update', sessionUpdate(session))
      })
    }
    const unsubscribeStream = session.stream.subscribe((event) => {
      connection.send('timeline', event)
      scheduleUpdate()
    })
    const unsubscribeRunner = session.onRunnerStatus(() => scheduleUpdate())
    connection.onClose(() => {
      unsubscribeStream()
      unsubscribeRunner()
      connections.delete(connection)
    })
  }

  const serveStatic = async (pathname: string, response: ServerResponse): Promise<void> => {
    const relativePath = decodeURIComponent(pathname === '/' ? '/index.html' : pathname)
    const file = resolve(publicRoot, `.${relativePath}`)
    if (file !== publicRoot && !file.startsWith(`${publicRoot}/`)) throw new ApiError(403, 'path_forbidden', 'static path is outside public root')
    const content = await readFile(file)
    response.statusCode = 200
    response.setHeader('content-type', MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream')
    response.end(content)
  }

  const handleApi = async (request: IncomingMessage, response: ServerResponse, url: URL, parts: string[]): Promise<void> => {
    const method = request.method ?? 'GET'
    if (method === 'GET' && url.pathname === '/api/config') {
      const dsh = diagnoseDshRuntime()
      const workspaceRoot = isAbsolute(relative(process.cwd(), workspacesRoot)) || relative(process.cwd(), workspacesRoot).startsWith('..') ? workspacesRoot : relative(process.cwd(), workspacesRoot)
      writeJson(response, 200, { version: API_VERSION, approvalTimeoutMs, llm: describeLlmConfig(loadLlmConfig()), dsh: { installed: dsh.installed, version: dsh.version ?? null, diagnostic: dsh.diagnostic }, workspaceRoot })
      return
    }
    if (parts[1] !== 'sessions') throw missing('API route not found')

    if (method === 'POST' && parts.length === 2) {
      const data = await body(request)
      if (data.title !== undefined && (typeof data.title !== 'string' || data.title.length > 120)) throw bad('title must be a string of at most 120 characters')
      const session = createSession(parseMode(data.mode), data.title as string | undefined)
      writeJson(response, 201, sessionState(session))
      return
    }
    if (method === 'GET' && parts.length === 2) {
      const summaries = [...sessions.values()].map(sessionSummary).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      writeJson(response, 200, summaries)
      return
    }

    const id = parts[2]
    if (!id || parts.length < 4) throw missing('API route not found')
    const session = getSession(id)
    const { stream } = session
    const route = parts[3]

    if (method === 'GET') {
      if (route === 'state') { writeJson(response, 200, sessionState(session)); return }
      if (route === 'events') { openEvents(request, response, session); return }
      if (route === 'report') { writeJson(response, 200, stream.report()); return }
      if (route === 'branches') { writeJson(response, 200, stream.branchList); return }
      if (route === 'units') { writeJson(response, 200, stream.cards.filter((card) => card.unit)); return }
      if (route === 'constraints') { writeJson(response, 200, stream.spec?.structuredConstraints ?? []); return }
      if (route === 'timeline') {
        const agentId = url.searchParams.get('agentId')
        const branchId = url.searchParams.get('branchId')
        const eventType = url.searchParams.get('eventType')
        const since = url.searchParams.has('since') ? Number(url.searchParams.get('since')) : undefined
        if (since !== undefined && !Number.isFinite(since)) throw bad('since must be a sequence number')
        const events = stream.events.filter((event) =>
          (!agentId || event.agentId === agentId)
          && (!branchId || event.branchId === branchId)
          && (!eventType || event.type === eventType)
          && (since === undefined || event.sequence > since))
        writeJson(response, 200, events)
        return
      }
      throw missing('API route not found')
    }
    if (method !== 'POST') throw missing('API route not found')

    if (route === 'spec' && parts.length === 4) {
      const data = await body(request)
      if (data.mode !== undefined && data.mode !== stream.mode) throw conflict('correction mode is immutable for a session; create another session')
      activeSession(session).stream.confirmSpec(parseSpec(data))
      writeJson(response, 200, sessionState(session))
      return
    }
    if (route === 'spec' && parts[4] === 'draft') {
      const data = await body(request)
      if (typeof data.request !== 'string' || !data.request.trim()) throw bad('request must be a non-empty string')
      writeJson(response, 200, await draftSpec(data.request.trim()))
      return
    }
    if (route === 'end') {
      session.cancelRunner('会话已结束')
      stream.end()
      writeJson(response, 200, sessionState(session))
      return
    }
    if (route === 'cancel') {
      activeSession(session)
      stream.cancel()
      session.cancelRunner('已被人工叫停')
      writeJson(response, 200, sessionState(session))
      return
    }
    if (route === 'actions') {
      const data = parseAction(await body(request))
      activeSession(session)
      if (!stream.spec) throw conflict('confirm a spec before executing actions', 'spec_required')
      const unitId = typeof data.args.unitId === 'string' ? data.args.unitId : undefined
      if (unitId) {
        const pending = stream.executeInUnit(unitId, data)
        pending.catch(() => undefined)
        await new Promise((resolve) => setTimeout(resolve, 0))
        writeJson(response, 202, sessionState(session))
        return
      }
      if (data.id && stream.cards.some((card) => card.id === data.id)) throw conflict(`duplicate card id: ${data.id}`, 'duplicate_card')
      const pending = stream.execute(data)
      pending.catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 0))
      writeJson(response, 202, sessionState(session))
      return
    }
    if (route === 'adapter-events') {
      const data = await body(request)
      activeSession(session)
      stream.recordAdapterEvent(data)
      writeJson(response, 202, sessionState(session))
      return
    }
    if (route === 'units') {
      const unit = parseUnit(await body(request))
      activeSession(session)
      if (!stream.spec) throw conflict('confirm a spec before executing units', 'spec_required')
      const pending = stream.executeUnit(unit)
      pending.catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 0))
      writeJson(response, 202, sessionState(session))
      return
    }
    if (route === 'constraints') {
      const data = await body(request)
      activeSession(session)
      if (!stream.spec) throw conflict('confirm a spec before adding constraints', 'spec_required')
      const structured = data.structured && typeof data.structured === 'object' ? data.structured as StructuredConstraint : undefined
      const text = typeof data.text === 'string' ? data.text.trim() : structured?.text?.trim()
      if (!text) throw bad('constraint text is required')
      stream.addHumanConstraint(text, structured)
      writeJson(response, 200, sessionState(session))
      return
    }
    if (route === 'demo') {
      const data = await body(request)
      const scenario = parseScenario(data.scenario)
      if (data.pace !== undefined && (typeof data.pace !== 'number' || !Number.isFinite(data.pace) || data.pace < 0)) throw bad('pace must be a non-negative number of milliseconds')
      activeSession(session)
      if (!stream.spec) throw conflict('confirm a spec before running the demo', 'spec_required')
      session.attach(new DemoRunner(stream, { scenario, pace: data.pace as number | undefined }))
      await new Promise((resolve) => setTimeout(resolve, 0))
      writeJson(response, 202, { ok: true, scenario })
      return
    }
    if (route === 'run') {
      const data = await body(request)
      if (data.request !== undefined && typeof data.request !== 'string') throw bad('request must be a string')
      if (data.maxSteps !== undefined && (!Number.isInteger(data.maxSteps) || (data.maxSteps as number) <= 0)) throw bad('maxSteps must be a positive integer')
      activeSession(session)
      if (!stream.spec) throw conflict('confirm a spec before running an agent', 'spec_required')
      if (session.busy) throw conflict('a runner is already driving this session', 'runner_busy')
      const runner = createConfiguredLlmRunner(stream, { request: data.request as string | undefined, maxSteps: data.maxSteps as number | undefined, workspaceRoot: session.workspaceRoot })
      if (!runner) throw conflict('no LLM agent is configured', 'llm_not_configured')
      session.attach(runner)
      writeJson(response, 202, { ok: true, model: runner.status.model ?? 'unknown' })
      return
    }
    if (route === 'cards' && parts[5] === 'decision') {
      const decision = parseDecision(await body(request))
      const card = findCard(session, parts[4])
      activeSession(session).stream.decide(card.id, decision)
      await new Promise((resolve) => setTimeout(resolve, 0))
      writeJson(response, 200, sessionState(session))
      return
    }
    if (route === 'cards' && parts[5] === 'cancel') {
      const card = findCard(session, parts[4])
      activeSession(session)
      if (card.state !== 'pending') throw conflict(`card ${card.id} is not pending`, 'card_not_pending')
      stream.cancelCard(card.id)
      writeJson(response, 200, sessionState(session))
      return
    }
    if (route === 'decide') {
      const data = await body(request)
      const card = findCard(session, typeof data.cardId === 'string' ? data.cardId : undefined)
      activeSession(session).stream.decide(card.id, parseDecision(data))
      await new Promise((resolve) => setTimeout(resolve, 0))
      writeJson(response, 200, sessionState(session))
      return
    }
    if (route === 'verify') {
      const data = await body(request)
      activeSession(session)
      if (typeof data.passed !== 'boolean') throw bad('passed must be a boolean')
      const card = findCard(session, typeof data.cardId === 'string' ? data.cardId : undefined)
      if (card.executionStatus !== 'succeeded') throw invalid('only succeeded cards can be verified')
      stream.verify(card.id, data.passed, typeof data.detail === 'string' ? data.detail : undefined)
      writeJson(response, 200, sessionState(session))
      return
    }
    if (route === 'rewind') {
      const data = await body(request)
      if (!Number.isInteger(data.turnBoundary) || typeof data.instruction !== 'string' || !data.instruction.trim()) throw bad('turnBoundary and instruction are required')
      const result = activeSession(session).stream.rewindAndFork(data.turnBoundary as number, data.instruction.trim())
      writeJson(response, 200, { ...sessionState(session), result })
      return
    }
    throw missing('API route not found')
  }

  const server = createServer(async (request, response) => {
    try {
      const origin = request.headers.origin
      const referer = request.headers.referer
      if ((origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) || (referer && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(referer))) {
        throw new ApiError(403, 'origin_forbidden', 'only loopback browser origins are allowed')
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts[0] === 'api') {
        await handleApi(request, response, url, parts)
        return
      }
      if (request.method !== 'GET') throw missing('route not found')
      await serveStatic(url.pathname, response)
    } catch (error) {
      const apiError = toApiError(error)
      if (response.headersSent) { response.end(); return }
      writeJson(response, apiError.status, { error: { code: apiError.code, message: apiError.message } })
    }
  })
  server.on('error', () => undefined)

  const close = (): Promise<void> => new Promise((resolve) => {
    for (const connection of connections) connection.close()
    for (const session of sessions.values()) session.cancelRunner('服务器关闭')
    server.closeAllConnections?.()
    server.close(() => resolve())
  })

  return { server, sessions, dataRoot, createSession, close }
}

const isMain = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false
if (isMain && process.env.NODE_ENV !== 'test') {
  const port = Number(process.env.PORT ?? 4173)
  const app = createDecisionServer()
  app.server.listen(port, '127.0.0.1', () => console.log(`Decision Stream: http://127.0.0.1:${port}`))
}
