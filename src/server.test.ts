import { describe, expect, it, afterEach } from 'vitest'
import { createDecisionServer } from './server.js'
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
    expect((await post(`${base}/api/sessions/${created.sessionId}/demo`, {})).status).toBe(202)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const state = await (await fetch(`${base}/api/sessions/${created.sessionId}/state`)).json() as { cards: Array<{ id: string }> }
    expect(state.cards[0]?.id).toBe('demo-red')
  })
})
