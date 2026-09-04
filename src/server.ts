import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DecisionStream } from './stream.js'
import { JsonlEventPersistence } from './persistence.js'
import type { ActionInput, ConfirmedSpec, CorrectionMode, HumanDecision } from './types.js'

const root = resolve(join(fileURLToPath(new URL('.', import.meta.url)), 'public'))
const dataRoot = resolve(process.env.DECISION_STREAM_DATA ?? join(process.cwd(), '.decision-stream'))
const maxBodyBytes = 1024 * 1024
const sessionIdPattern = /^[A-Za-z0-9_-]{1,80}$/

class ApiError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message) } }
const bad = (message: string) => new ApiError(400, 'invalid_request', message)
const missing = (message: string) => new ApiError(404, 'not_found', message)
const conflict = (message: string) => new ApiError(409, 'conflict', message)
const invalid = (message: string) => new ApiError(422, 'unprocessable_entity', message)

function assertSessionId(value: string): void { if (!sessionIdPattern.test(value)) throw bad('invalid sessionId') }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('JSON body must be an object'); return value as Record<string, unknown> }
function stringField(value: Record<string, unknown>, key: string): string { if (typeof value[key] !== 'string' || !value[key].trim()) throw bad(`${key} must be a non-empty string`); return value[key] as string }
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const length = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(length) && length > maxBodyBytes) throw new ApiError(413, 'body_too_large', 'request body exceeds 1 MiB')
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of request) { const buffer = Buffer.from(chunk as Uint8Array); size += buffer.length; if (size > maxBodyBytes) throw new ApiError(413, 'body_too_large', 'request body exceeds 1 MiB'); chunks.push(buffer) }
  if (!size) return {}
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (error) { if (error instanceof ApiError) throw error; throw bad('malformed JSON') }
}
function writeJson(response: ServerResponse, status: number, value: unknown): void { response.statusCode = status; response.setHeader('content-type', 'application/json; charset=utf-8'); response.end(JSON.stringify(value)) }
function state(stream: DecisionStream): unknown { return { sessionId: stream.sessionId, mode: stream.mode, spec: stream.spec, cards: stream.cards, timeline: stream.events, branches: stream.branchList, report: stream.report() } }
function action(value: Record<string, unknown>): ActionInput {
  if (typeof value.tool !== 'string' || typeof value.kind !== 'string' || typeof value.description !== 'string' || !value.args || typeof value.args !== 'object') throw bad('action requires tool, kind, description and args')
  if (!['write', 'read', 'command', 'validate'].includes(value.kind as string)) throw bad('unsupported action kind')
  return value as unknown as ActionInput
}
function spec(value: Record<string, unknown>): ConfirmedSpec { if (typeof value.id !== 'string' || typeof value.request !== 'string' || !Array.isArray(value.constraints) || value.confirmed !== true) throw bad('spec requires id, request, constraints[] and confirmed=true'); if (value.constraints.some((item) => typeof item !== 'string')) throw bad('spec constraints must be strings'); return value as unknown as ConfirmedSpec }
function decision(value: Record<string, unknown>): HumanDecision { if (!['allow', 'alternative', 'rewrite', 'cancel'].includes(String(value.kind))) throw bad('invalid decision kind'); if (value.kind !== 'allow' && value.kind !== 'cancel' && (typeof value.text !== 'string' || !value.text.trim())) throw bad('decision text is required'); return value as unknown as HumanDecision }

export function createDecisionServer(options: { dataRoot?: string; port?: number } = {}) {
  const directory = resolve(options.dataRoot ?? dataRoot); mkdirSync(directory, { recursive: true })
  const sessions = new Map<string, DecisionStream>()
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.jsonl'))) {
    const id = basename(file, '.jsonl'); if (!sessionIdPattern.test(id)) continue
    const persistence = new JsonlEventPersistence(join(directory, file)); const events = persistence.load()
    if (events[0]?.sessionId !== id) continue
    sessions.set(id, new DecisionStream({ sessionId: id, mode: 'forward-only', persistence, restoredEvents: events }))
  }
  const get = (id: string): DecisionStream => { assertSessionId(id); const stream = sessions.get(id); if (!stream) throw missing(`session ${id} not found`); return stream }
  const create = (mode: CorrectionMode = 'forward-only'): DecisionStream => { if (!['forward-only', 'rewind-and-fork'].includes(mode)) throw bad('invalid correction mode'); const id = `session-${randomUUID()}`; const persistence = new JsonlEventPersistence(join(directory, `${id}.jsonl`)); const stream = new DecisionStream({ sessionId: id, mode, persistence }); sessions.set(id, stream); return stream }

  const server = createServer(async (request, response) => {
    try {
      const origin = request.headers.origin
      const referer = request.headers.referer
      if ((origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) || (referer && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(referer))) throw new ApiError(403, 'origin_forbidden', 'only loopback browser origins are allowed')
      const parsed = new URL(request.url ?? '/', 'http://127.0.0.1'); const parts = parsed.pathname.split('/').filter(Boolean)
      if (parts[0] === 'api') {
        if (request.method === 'POST' && parsed.pathname === '/api/sessions') { const data = await body(request); const stream = create(data.mode as CorrectionMode | undefined); writeJson(response, 201, state(stream)); return }
        if (request.method === 'GET' && parsed.pathname === '/api/sessions') { writeJson(response, 200, [...sessions.values()].map((stream) => ({ sessionId: stream.sessionId, mode: stream.mode, spec: stream.spec }))); return }
        const id = parts[2]; if (!id) throw missing('API route not found'); const stream = get(id)
        if (request.method === 'GET' && parts[3] === 'state') { writeJson(response, 200, state(stream)); return }
        if (request.method === 'GET' && parts[3] === 'timeline') { const agentId = parsed.searchParams.get('agentId'); const branchId = parsed.searchParams.get('branchId'); const eventType = parsed.searchParams.get('eventType'); writeJson(response, 200, stream.events.filter((event) => (!agentId || event.agentId === agentId) && (!branchId || event.branchId === branchId) && (!eventType || event.type === eventType))); return }
        if (request.method === 'GET' && parts[3] === 'report') { writeJson(response, 200, stream.report()); return }
        if (request.method === 'GET' && parts[3] === 'branches') { writeJson(response, 200, stream.branchList); return }
        if (request.method === 'POST' && parts[3] === 'spec') { const data = await body(request); if (data.mode && data.mode !== stream.mode) throw conflict('correction mode is immutable for a session; create another session'); stream.confirmSpec(spec(data)); writeJson(response, 200, state(stream)); return }
        if (request.method === 'POST' && (parts[3] === 'actions' || parts[3] === 'demo')) { if (!stream.spec) throw conflict('confirm a spec before executing actions'); const data: ActionInput = parts[3] === 'demo' ? { id: 'demo-red', tool: 'write_file', kind: 'write', description: '选择 SQLite 存储', args: { path: 'store/db.sqlite' }, agentId: 'demo-agent' } : action(await body(request)); const pending = stream.execute(data); await new Promise((resolve) => setTimeout(resolve, 0)); void pending.catch(() => undefined); writeJson(response, 202, state(stream)); return }
        if (request.method === 'POST' && parts[3] === 'cards' && parts[5] === 'decision') { const card = stream.cards.find((item) => item.id === parts[4]); if (!card) throw missing(`card ${parts[4]} not found`); if (card.state !== 'pending') throw conflict(`card ${card.id} is not pending`); stream.decide(card.id, decision(await body(request))); writeJson(response, 200, state(stream)); return }
        if (request.method === 'POST' && parts[3] === 'decide') { const data = await body(request); const card = stream.cards.find((item) => item.id === String(data.cardId)); if (!card) throw missing('card not found'); stream.decide(card.id, decision(data)); writeJson(response, 200, state(stream)); return }
        if (request.method === 'POST' && parts[3] === 'verify') { const data = await body(request); const card = stream.cards.find((item) => item.id === String(data.cardId)); if (!card) throw missing('card not found'); if (card.executionStatus !== 'succeeded') throw invalid('only succeeded cards can be verified'); stream.verify(card.id, data.passed !== false, typeof data.detail === 'string' ? data.detail : undefined); writeJson(response, 200, state(stream)); return }
        if (request.method === 'POST' && parts[3] === 'cancel') { stream.cancel(); writeJson(response, 200, state(stream)); return }
        if (request.method === 'POST' && parts[3] === 'cards' && parts[5] === 'cancel') { const card = stream.cards.find((item) => item.id === parts[4]); if (!card) throw missing(`card ${parts[4]} not found`); stream.cancelCard(card.id); writeJson(response, 200, state(stream)); return }
        if (request.method === 'POST' && parts[3] === 'rewind') { const data = await body(request); if (!Number.isInteger(data.turnBoundary) || typeof data.instruction !== 'string' || !data.instruction.trim()) throw bad('turnBoundary and instruction are required'); const result = stream.rewindAndFork(data.turnBoundary as number, data.instruction); writeJson(response, 200, { ...state(stream) as object, result }); return }
        throw missing('API route not found')
      }
      if (request.method !== 'GET') throw missing('route not found')
      const relative = decodeURIComponent(parsed.pathname === '/' ? '/index.html' : parsed.pathname)
      const file = resolve(root, `.${relative}`); if (file !== root && !file.startsWith(`${root}/`)) throw new ApiError(403, 'path_forbidden', 'static path is outside public root')
      response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(await readFile(file))
    } catch (error) { const apiError = error instanceof ApiError ? error : error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT' ? missing('resource not found') : error instanceof Error && /duplicate|conflicting|not enabled|boundary/.test(error.message) ? conflict(error.message) : new ApiError(500, 'internal_error', error instanceof Error ? error.message : String(error)); writeJson(response, apiError.status, { error: { code: apiError.code, message: apiError.message } }) }
  })
  server.on('error', () => undefined)
  return { server, sessions, createSession: create }
}

const app = createDecisionServer()
if (process.env.NODE_ENV !== 'test') app.server.listen(Number(process.env.PORT ?? 4173), '127.0.0.1', () => console.log('Decision Stream demo: http://127.0.0.1:4173'))
