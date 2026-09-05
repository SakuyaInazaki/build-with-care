import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { DEMO_PROMPT } from '../shared/types.js'
import { fixture, until } from './helpers.js'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup()
})
function setup() {
  const f = fixture()
  fixtures.push(f)
  return f
}

describe('real dsh loop with explicitly scripted demo executor', () => {
  it('blocks the conflicting write, forwards correction, repairs actual files and links checks', async () => {
    const { manager } = setup(),
      state = manager.create(DEMO_PROMPT, 'demo')
    await manager.start(
      state.id,
      state.constraints.map((c) => c.text),
    )
    await until(() => state.status === 'waiting' || state.status === 'error')
    expect(state.error).toBeUndefined()
    const runtime = manager.runtime(state.id),
      gate = state.gates.find((g) => g.status === 'pending')!
    expect(gate).toBeDefined()
    expect(runtime.workspace.read('index.html')).not.toContain('localStorage')
    const requestId = randomUUID()
    const input = {
      requestId,
      revision: state.revision,
      decisionId: gate.decisionId,
      gateId: gate.id,
      action: 'correct' as const,
      text: '只使用页面内存，刷新后清空报名信息',
    }
    const verdict = runtime.verdict(input)
    expect(runtime.verdict(input).id).toBe(verdict.id)
    await until(() => ['completed', 'error'].includes(state.status))
    expect(state.error).toBeUndefined()
    expect(state.status).toBe('completed')
    expect(runtime.workspace.read('index.html')).toContain('let registrations = []')
    expect(runtime.workspace.read('index.html')).not.toContain('localStorage')
    expect(state.steps.find((s) => s.id === gate.stepId)?.status).toBe('denied')
    expect(state.interventions).toHaveLength(1)
    expect(state.interventions[0].progress).toBe('verified')
    expect(state.verifications.length).toBeGreaterThanOrEqual(3)
    expect(state.verifications.every((v) => v.passed)).toBe(true)
    expect(manager.summary(state.id).unreviewed).toBe(1)
    expect(manager.store.events(state.id).some((e) => e.type === 'human.intervention')).toBe(true)
  })
  it('settles a pending gate when stopped and rejects a stale approval', async () => {
    const { manager } = setup(),
      state = manager.create(DEMO_PROMPT, 'demo')
    await manager.start(
      state.id,
      state.constraints.map((c) => c.text),
    )
    await until(() => state.status === 'waiting' || state.status === 'error')
    expect(state.error).toBeUndefined()
    const runtime = manager.runtime(state.id),
      gate = state.gates.find((g) => g.status === 'pending')!
    runtime.requestStop()
    await until(() => state.status === 'stopped')
    expect(gate.status).toBe('cancelled')
    expect(runtime.workspace.read('index.html')).not.toContain('localStorage')
    expect(() =>
      runtime.verdict({
        requestId: randomUUID(),
        revision: state.revision,
        decisionId: gate.decisionId,
        gateId: gate.id,
        action: 'allow-once',
      }),
    ).toThrow()
  })
})
