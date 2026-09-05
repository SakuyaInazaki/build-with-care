import { describe, expect, it } from 'vitest'
import { DshAdapterUnavailableError, MockDshAdapter, diagnoseDshRuntime, mapDshEvent, requireRealDshRuntime } from './dsh.js'

describe('dsh adapter contract', () => {
  it('keeps pre-execute pending until allow or deny and preserves deny reason', async () => {
    const adapter = new MockDshAdapter(); adapter.start('s1')
    const pending = adapter.preExecute({ sessionId: 's1', branchId: 'main', agentId: 'a1', turn: 1, step: 1, tool: 'write_file', arguments: { path: 'x' }, callId: 'call-1' })
    expect(adapter.pending.has('call-1')).toBe(true)
    let settled = false; void pending.then(() => { settled = true }); await Promise.resolve(); expect(settled).toBe(false)
    adapter.deny('call-1', '人要求后续使用 Postgres')
    await expect(pending).resolves.toEqual({ kind: 'deny', reason: '人要求后续使用 Postgres' })
    expect(adapter.events.map((event) => event.type)).toEqual(['session/start', 'tools/pre-execute', 'tools/pre-execute/deny'])
  })

  it('injects only the next admitted request and cancels pending calls', async () => {
    const adapter = new MockDshAdapter(); adapter.start('s1')
    const gate = adapter.preExecute({ sessionId: 's1', branchId: 'main', agentId: 'a1', turn: 2, step: 1, tool: 'write_file', arguments: {}, callId: 'call-2' })
    await adapter.inject({ sessionId: 's1', branchId: 'main', agentId: 'a1', turn: 2, step: 1, message: '后续只能使用 Postgres' })
    expect(adapter.injected[0]?.message).toBe('后续只能使用 Postgres')
    expect(adapter.events.find((event) => event.type === 'agent.inject')?.payload).toMatchObject({ affects: 'future-only', delivery: 'next-admitted-request' })
    await adapter.cancel({ sessionId: 's1', agentId: 'a1', turn: 2, reason: '人工叫停' })
    await expect(gate).resolves.toEqual({ kind: 'deny', reason: '人工叫停' })
    expect(adapter.pending.size).toBe(0)
  })

  it('requires turn boundaries for fork and emits ordered session events', async () => {
    const adapter = new MockDshAdapter(); adapter.start('s1')
    await expect(adapter.fork({ sessionId: 's1', turnBoundary: 1, instruction: 'redo' })).rejects.toThrow(/completed turn/)
    adapter.completeTurn({ sessionId: 's1', branchId: 'main', agentId: 'a1', turn: 1 })
    await expect(adapter.fork({ sessionId: 's1', turnBoundary: 1, instruction: 'redo' })).resolves.toEqual({ childSessionId: 's1:fork:1', turnBoundary: 1 })
    expect(adapter.events.map((event) => event.sequence)).toEqual([1, 2, 3])
    expect(adapter.events.map((event) => event.type)).toEqual(['session/start', 'turn/end', 'session/fork'])
  })

  it('maps known and unknown dsh events while retaining provenance', () => {
    const known = mapDshEvent({ type: 'tool/result', sessionId: 's1', sequence: 4, provider: 'dsh', version: '0.1.3-alpha.1', payload: { ok: true } })
    const unknown = mapDshEvent({ type: 'new/future-event', sessionId: 's1', sequence: 5, provider: 'dsh', version: '0.1.3-alpha.1', payload: { x: 1 } })
    expect(known.type).toBe('tool-result'); expect(known.provider).toBe('dsh'); expect(known.version).toBe('0.1.3-alpha.1'); expect(known.externalType).toBe('tool/result')
    expect(unknown.type).toBe('adapter-event'); expect(unknown.externalType).toBe('new/future-event'); expect(unknown.metadata?.dshPayload).toEqual({ x: 1 })
  })

  it('diagnoses missing or wrong runtime without pretending to connect', () => {
    const diagnosis = diagnoseDshRuntime('@deepseek-ai/dsh', '0.1.3-alpha.1')
    expect(diagnosis.installed).toBe(false)
    expect(() => requireRealDshRuntime('@deepseek-ai/dsh', '0.1.3-alpha.1')).toThrow(DshAdapterUnavailableError)
    expect(() => requireRealDshRuntime('@deepseek-ai/dsh', '0.1.3-alpha.1')).toThrow(/not installed|but .* installed/)
  })
})
