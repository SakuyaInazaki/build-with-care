import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { DEMO_PROMPT } from '../shared/types.js'
import { Manager } from '../server/manager.js'
import { fixture, until } from './helpers.js'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup()
})
async function pendingDemo() {
  const f = fixture()
  fixtures.push(f)
  const state = f.manager.create(DEMO_PROMPT, 'demo')
  await f.manager.start(
    state.id,
    state.constraints.map((c) => c.text),
  )
  await until(() => state.status === 'waiting')
  return { ...f, state }
}
async function completedDemo() {
  const f = await pendingDemo(),
    gate = f.state.gates[0]
  f.manager.runtime(f.state.id).verdict({
    requestId: randomUUID(),
    revision: f.state.revision,
    decisionId: gate.decisionId,
    gateId: gate.id,
    action: 'enforce',
  })
  await until(() => f.state.status === 'completed')
  return f
}

it('adds a new requirement without a decision ID, invalidates a pending gate and performs the change', async () => {
  const { manager, state } = await pendingDemo(),
    gate = state.gates[0]
  const input = {
    requestId: randomUUID(),
    revision: state.revision,
    kind: 'requirement' as const,
    text: '只使用页面内存，刷新后清空；报名名额改为 30 人',
  }
  await manager.addInput(state.id, input)
  await manager.addInput(state.id, input)
  await until(() => state.status === 'completed')
  expect(state.revision).toBe(2)
  expect(gate.status).toBe('denied')
  expect(state.constraints.at(-1)?.text).toBe(input.text)
  expect(state.interventions.filter((i) => i.action === 'followup')).toHaveLength(1)
  expect(manager.runtime(state.id).workspace.read('index.html')).toContain('共 30 个名额')
  expect(manager.runtime(state.id).workspace.read('index.html')).not.toContain('localStorage')
  expect(state.interventions.at(-1)?.subsequentStepIds.length).toBeGreaterThan(0)
  expect(() =>
    manager.runtime(state.id).verdict({
      requestId: randomUUID(),
      revision: 2,
      decisionId: gate.decisionId,
      gateId: gate.id,
      action: 'allow-once',
    }),
  ).toThrow()
})

it('keeps an idea as reference and leaves the pending conflict unresolved', async () => {
  const { manager, state } = await pendingDemo(),
    revision = state.revision,
    constraints = structuredClone(state.constraints)
  await manager.addInput(state.id, {
    requestId: randomUUID(),
    revision,
    kind: 'idea',
    text: '要不要给首次参加的人增加引导？',
  })
  expect(state.status).toBe('waiting')
  expect(state.gates[0].status).toBe('pending')
  expect(state.revision).toBe(revision)
  expect(state.constraints).toEqual(constraints)
  expect(state.interventions[0].progress).toBe('recorded')
  const gate = state.gates[0]
  manager.runtime(state.id).verdict({
    requestId: randomUUID(),
    revision,
    decisionId: gate.decisionId,
    gateId: gate.id,
    action: 'enforce',
  })
  await until(() => state.status === 'completed')
  expect(state.messages.some((m) => m.text.includes('想法已收到'))).toBe(true)
  expect(state.interventions[0].progress).toBe('delivered')
  expect(state.interventions[0].subsequentStepIds).toHaveLength(0)
})

it('continues a completed task and preserves existing constraints when an idea is discussed', async () => {
  const { manager, state } = await completedDemo()
  await manager.addInput(state.id, {
    requestId: randomUUID(),
    revision: state.revision,
    kind: 'requirement',
    text: '报名名额改为 35 人',
  })
  await until(() => state.status === 'completed')
  const file = manager.runtime(state.id).workspace.read('index.html'),
    steps = state.steps.length,
    revision = state.revision
  expect(file).toContain('共 35 个名额')
  await manager.addInput(state.id, {
    requestId: randomUUID(),
    revision,
    kind: 'idea',
    text: '是否考虑两栏布局？',
  })
  await until(() => state.status === 'completed')
  expect(state.steps).toHaveLength(steps)
  expect(state.revision).toBe(revision)
  expect(manager.runtime(state.id).workspace.read('index.html')).toBe(file)
})

it('explicitly continues saved history after a restart without replaying its original demo writes', async () => {
  const { manager, state, dir } = await completedDemo(),
    previousSteps = state.steps.length
  await manager.dispose()
  const restored = new Manager(dir, manager.settings)
  try {
    await restored.addInput(state.id, {
      requestId: randomUUID(),
      revision: state.revision,
      kind: 'requirement',
      text: '报名名额改为 40 人',
    })
    const next = restored.get(state.id)
    await until(() => next.status === 'completed' || next.status === 'error')
    expect(next.error).toBeUndefined()
    expect(restored.runtime(state.id).workspace.read('index.html')).toContain('共 40 个名额')
    expect(
      next.steps.slice(previousSteps).some((s) => String(s.args.content).includes('localStorage')),
    ).toBe(false)
    expect(next.steps.slice(0, previousSteps).map((s) => s.id)).toEqual(
      state.steps.map((s) => s.id),
    )
  } finally {
    await restored.dispose()
  }
})

it('rejects stale updates, invalid replacements and a second executing task without saving the input', async () => {
  const { manager, state } = await completedDemo()
  const count = state.interventions.length
  const input = {
    requestId: randomUUID(),
    revision: state.revision,
    kind: 'requirement' as const,
    text: '报名名额改为 50 人',
  }
  await expect(
    manager.addInput(state.id, { ...input, revision: state.revision + 1 }),
  ).rejects.toThrow()
  await expect(
    manager.addInput(state.id, { ...input, replaceConstraintId: randomUUID() }),
  ).rejects.toThrow()
  const other = manager.create(DEMO_PROMPT, 'demo')
  await manager.start(
    other.id,
    other.constraints.map((c) => c.text),
  )
  await expect(manager.addInput(state.id, input)).rejects.toThrow('另一个任务')
  expect(state.interventions).toHaveLength(count)
  expect(state.status).toBe('completed')
})
