import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { JsonlEventPersistence } from './persistence.js'
import { DecisionStream } from './stream.js'

const spec = { id: 'persist-spec', request: 'database', constraints: ['必须使用 Postgres，不允许 SQLite'], confirmed: true }
const action = { id: 'persist-card', tool: 'write_file', kind: 'write' as const, description: '选择 SQLite', args: { path: 'db.sqlite' } }

describe('JSONL persistence', () => {
  it('writes events and restores completed cards and reports', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'decision-stream-'))
    const persistence = new JsonlEventPersistence(join(directory, 'one.jsonl'))
    const stream = new DecisionStream({ sessionId: 'one', persistence }); stream.confirmSpec(spec)
    const pending = stream.execute(action); stream.decide(action.id, { kind: 'allow' }); await pending
    const restored = new DecisionStream({ sessionId: 'one', persistence, restoredEvents: persistence.load() })
    expect(restored.cards[0]?.id).toBe(action.id)
    expect(restored.spec?.id).toBe(spec.id)
    expect(restored.report().events.length).toBe(stream.events.length)
    expect(readFileSync(persistence.filePath, 'utf8').trim().split('\n').every((line) => JSON.parse(line).sessionId === 'one')).toBe(true)
    expect(restored.spec?.constraints.filter((constraint) => constraint === '后续使用 Postgres').length).toBe(0)
  })

  it('does not duplicate a persisted correction during recovery', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'decision-stream-')); const persistence = new JsonlEventPersistence(join(directory, 'correction.jsonl'))
    const stream = new DecisionStream({ sessionId: 'correction', persistence }); stream.confirmSpec(spec)
    const pending = stream.execute({ ...action, id: 'correction-card' }); stream.decide('correction-card', { kind: 'alternative', text: '后续使用 Postgres' }); await pending
    const restored = new DecisionStream({ sessionId: 'correction', persistence, restoredEvents: persistence.load() })
    expect(restored.spec?.constraints.filter((constraint) => constraint === '后续使用 Postgres')).toHaveLength(1)
  })

  it('marks a pending gate interrupted after restart and ignores a partial final line', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'decision-stream-'))
    const file = join(directory, 'pending.jsonl'); const persistence = new JsonlEventPersistence(file)
    const stream = new DecisionStream({ sessionId: 'pending', persistence }); stream.confirmSpec(spec); void stream.execute(action); await new Promise((resolve) => setTimeout(resolve, 0))
    const before = persistence.load(); appendFileSync(file, '{"partial":', 'utf8')
    const recoveredPersistence = new JsonlEventPersistence(file)
    const restored = new DecisionStream({ sessionId: 'pending', persistence: recoveredPersistence, restoredEvents: recoveredPersistence.load() })
    expect(recoveredPersistence.recovery.ignoredTrailingBytes).toBe(true)
    expect(restored.cards[0]?.state).toBe('interrupted')
    expect(restored.cards[0]?.executionStatus).toBe('interrupted')
    expect(restored.events.length).toBeGreaterThan(before.length)
  })

  it('rejects a malformed complete row instead of silently losing data', () => {
    const directory = mkdtempSync(join(tmpdir(), 'decision-stream-')); const file = join(directory, 'bad.jsonl')
    appendFileSync(file, '{"broken":true}\n', 'utf8')
    expect(() => new JsonlEventPersistence(file)).toThrow(/invalid JSONL event/)
  })
})
