import { describe, expect, it, afterEach } from 'vitest'
import { createDecisionServer } from './reference-server.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const spec = { id: 'http-spec', request: 'database', constraints: ['必须使用 Postgres，不允许 SQLite'], confirmed: true }
const post = (url: string, value: unknown, init: RequestInit = {}) => fetch(url, { ...init, method: 'POST', headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }, body: JSON.stringify(value) })

describe('HTTP contract and isolation', () => {
  const apps: ReturnType<typeof createDecisionServer>[] = []
  afterEach(() => { for (const app of apps) app.server.close(); apps.length = 0 })

  it('uses explicit session routes and never crosses card ids between sessions', async () => {
    const app = createDecisionServer({ dataRoot: mkdtempSync(join(tmpdir(), 'decision-http-')) }); apps.push(app)
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', () => resolve()))
    const address = app.server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    const first = await (await post(`${base}/api/sessions`, { mode: 'forward-only' })).json() as { sessionId: string }
    const second = await (await post(`${base}/api/sessions`, { mode: 'rewind-and-fork' })).json() as { sessionId: string }
    expect((await post(`${base}/api/sessions/${first.sessionId}/spec`, spec)).status).toBe(200)
    expect((await post(`${base}/api/sessions/${second.sessionId}/spec`, { ...spec, id: 'other' })).status).toBe(200)
    expect((await post(`${base}/api/sessions/${first.sessionId}/actions`, { tool: 'x', kind: 'write', description: '选择 SQLite', args: { path: 'db.sqlite' } })).status).toBe(202)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const wrong = await post(`${base}/api/sessions/${second.sessionId}/cards/card-1/decision`, { kind: 'allow' })
    expect(wrong.status).toBe(404)
    const state = await (await fetch(`${base}/api/sessions/${first.sessionId}/state`)).json() as { cards: Array<{ id: string }> }
    expect(state.cards[0]?.id).toBe('card-1')
  })

  it('returns structured errors, rejects hostile origins, and blocks traversal', async () => {
    const app = createDecisionServer({ dataRoot: mkdtempSync(join(tmpdir(), 'decision-http-')) }); apps.push(app)
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', () => resolve()))
    const address = app.server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    const missing = await fetch(`${base}/api/sessions/nope/state`); expect(missing.status).toBe(404); expect((await missing.json()).error.code).toBe('not_found')
    const origin = await fetch(`${base}/api/sessions`, { headers: { origin: 'https://evil.example' } }); expect(origin.status).toBe(403); expect((await origin.json()).error.code).toBe('origin_forbidden')
    const traversal = await fetch(`${base}/../package.json`); expect([403, 404]).toContain(traversal.status)
  })

  it('gives the demo endpoint a stable card identity for its red gate', async () => {
    const app = createDecisionServer({ dataRoot: mkdtempSync(join(tmpdir(), 'decision-http-')) }); apps.push(app)
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', () => resolve()))
    const address = app.server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    const created = await (await post(`${base}/api/sessions`, { mode: 'forward-only' })).json() as { sessionId: string }
    await post(`${base}/api/sessions/${created.sessionId}/spec`, spec)
    expect((await post(`${base}/api/sessions/${created.sessionId}/demo`, { scenario: 'red-only' })).status).toBe(202)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const state = await (await fetch(`${base}/api/sessions/${created.sessionId}/state`)).json() as { cards: Array<{ id: string }> }
    expect(state.cards[0]?.id).toBe('demo-red')
  })

  it('executes work units, records forward-only constraints, and freezes writes after end', async () => {
    const app = createDecisionServer({ dataRoot: mkdtempSync(join(tmpdir(), 'decision-http-')) }); apps.push(app)
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', () => resolve()))
    const address = app.server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    const created = await (await post(`${base}/api/sessions`, {})).json() as { sessionId: string }
    expect((await post(`${base}/api/sessions/${created.sessionId}/spec`, { id: 's', request: '数据库', constraints: ['必须使用 Postgres'], confirmed: true })).status).toBe(200)
    expect((await post(`${base}/api/sessions/${created.sessionId}/units`, { id: 'u1', goal: '检查 schema', decisions: [], toolCalls: [{ tool: 'validate', kind: 'validate', description: '检查 schema', args: { target: 'schema.sql' } }] })).status).toBe(202)
    expect((await post(`${base}/api/sessions/${created.sessionId}/constraints`, { text: '后续不允许 SQLite' })).status).toBe(200)
    const constraints = await (await fetch(`${base}/api/sessions/${created.sessionId}/constraints`)).json() as Array<{ affectsFromTurn?: number }>
    expect(constraints.some((item) => item.affectsFromTurn !== undefined)).toBe(true)
    expect((await post(`${base}/api/sessions/${created.sessionId}/end`, {})).status).toBe(200)
    const ended = await post(`${base}/api/sessions/${created.sessionId}/constraints`, { text: '之后不允许 MySQL' })
    expect(ended.status).toBe(409)
  })

  it('keeps dsh admission separate from execution and records post/result through adapter-events', async () => {
    const app = createDecisionServer({ dataRoot: mkdtempSync(join(tmpdir(), 'decision-http-')) }); apps.push(app)
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', () => resolve()))
    const address = app.server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    const created = await (await post(`${base}/api/sessions`, {})).json() as { sessionId: string }
    expect((await post(`${base}/api/sessions/${created.sessionId}/spec`, { ...spec, id: 'dsh' })).status).toBe(200)
    const first = { tool: 'write', kind: 'write', description: 'dsh writes a file', args: { source: 'dsh', callId: 'c1', path: 'dsh.txt', arguments: { path: 'dsh.txt' } }, agentId: 'dsh-agent' }
    expect((await post(`${base}/api/sessions/${created.sessionId}/units`, { id: 'dsh-unit', goal: 'external dsh step', decisions: [], toolCalls: [first] })).status).toBe(202)
    await new Promise((resolve) => setTimeout(resolve, 10))
    let state = await (await fetch(`${base}/api/sessions/${created.sessionId}/state`)).json() as { cards: Array<{ id: string; executionStatus: string }>; timeline: Array<{ type: string }> }
    expect(state.cards.find((card) => card.id === 'dsh-unit')?.executionStatus).toBe('running')
    expect(state.timeline.some((event) => event.type === 'tool-result')).toBe(false)
    expect((await post(`${base}/api/sessions/${created.sessionId}/actions`, { ...first, id: 'dsh-call-2', args: { ...first.args, unitId: 'dsh-unit', callId: 'c2' } })).status).toBe(202)
    expect((await post(`${base}/api/sessions/${created.sessionId}/adapter-events`, { type: 'tool-result', payload: { unitId: 'dsh-unit', callId: 'c1', tool: 'write', ok: true, output: { written: true } } })).status).toBe(202)
    expect((await post(`${base}/api/sessions/${created.sessionId}/adapter-events`, { type: 'tool-result', payload: { unitId: 'dsh-unit', callId: 'c2', tool: 'write', ok: true, output: { written: true }, evidence: { kind: 'check', detail: 'dsh verified', passed: true } } })).status).toBe(202)
    state = await (await fetch(`${base}/api/sessions/${created.sessionId}/state`)).json() as { cards: Array<{ id: string; state: string; executionStatus: string }>; timeline: Array<{ type: string }> }
    expect(state.cards.find((card) => card.id === 'dsh-unit')).toMatchObject({ state: 'verified', executionStatus: 'succeeded' })
    expect(state.timeline.filter((event) => event.type === 'tool-result')).toHaveLength(2)
  })
})
