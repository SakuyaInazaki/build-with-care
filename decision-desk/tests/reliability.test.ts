import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DEMO_PROMPT, type Review } from '../shared/types.js'
import { demoReview } from '../server/reviewer.js'
import { Store } from '../server/store.js'
import { Workspace, inspectHtml } from '../server/workspace.js'
import { fixture, until } from './helpers.js'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup()
})
function setup(settings: Parameters<typeof fixture>[0] = {}) {
  const f = fixture(settings)
  fixtures.push(f)
  return f
}
const execution: Review = {
  classification: 'execution',
  title: '普通执行',
  summary: '测试审查',
  impact: '',
  constraintIds: [],
  evidence: '',
  options: [],
  topic: 'test',
  source: 'system',
}

describe('pending operations and evidence', () => {
  it('fails closed when a reviewer ignores its timeout and still allows stopping', async () => {
    const { manager } = setup({ reviewTimeoutMs: 30 }),
      state = manager.create(DEMO_PROMPT, 'demo')
    await manager.start(
      state.id,
      state.constraints.map((c) => c.text),
      { reviewer: () => new Promise(() => {}) },
    )
    await until(() => state.status === 'waiting')
    expect(state.steps[0].review?.classification).toBe('uncertain')
    expect(state.files).toHaveLength(0)
    manager.runtime(state.id).requestStop()
    await until(() => state.status === 'stopped')
    expect(state.gates[0].status).toBe('cancelled')
  })

  it('cancels an in-flight uncooperative reviewer immediately', async () => {
    const { manager } = setup({ reviewTimeoutMs: 60000 }),
      state = manager.create(DEMO_PROMPT, 'demo')
    await manager.start(
      state.id,
      state.constraints.map((c) => c.text),
      { reviewer: () => new Promise(() => {}) },
    )
    await until(() => state.steps.length === 1)
    manager.runtime(state.id).requestStop()
    await until(() => state.status === 'stopped', 1500)
    expect(state.steps[0].status).toBe('cancelled')
    expect(state.files).toHaveLength(0)
  })

  it('expires a human gate without releasing its write', async () => {
    const { manager } = setup({ gateTimeoutMs: 50 }),
      state = manager.create(DEMO_PROMPT, 'demo')
    await manager.start(
      state.id,
      state.constraints.map((c) => c.text),
    )
    await until(() => state.status === 'stopped')
    expect(state.gates[0].status).toBe('expired')
    expect(manager.runtime(state.id).workspace.read('index.html')).not.toContain('localStorage')
  })

  it('limits allow-once to one gate and leaves the original failing requirement visible', async () => {
    const { manager } = setup(),
      state = manager.create(DEMO_PROMPT, 'demo')
    await manager.start(
      state.id,
      state.constraints.map((c) => c.text),
    )
    await until(() => state.status === 'waiting')
    const runtime = manager.runtime(state.id),
      gate = state.gates[0]
    const input = {
      requestId: randomUUID(),
      revision: state.revision,
      decisionId: gate.decisionId,
      gateId: gate.id,
      action: 'allow-once' as const,
    }
    runtime.verdict(input)
    await until(() => state.status === 'completed')
    expect(state.revision).toBe(1)
    expect(runtime.workspace.read('index.html')).toContain('localStorage')
    expect(state.verifications.some((v) => !v.passed && v.name === '无浏览器持久化引用')).toBe(true)
    expect(() => runtime.verdict({ ...input, requestId: randomUUID() })).toThrow()
    expect(manager.summary(state.id).allowedOnce).toBe(1)
  })

  it('rechecks a proposed action when a blue-card correction changes its constraint revision mid-review', async () => {
    const { manager } = setup(),
      state = manager.create(DEMO_PROMPT, 'demo')
    let release!: (review: Review) => void
    const revisions: number[] = []
    await manager.start(
      state.id,
      state.constraints.map((c) => c.text),
      {
        reviewer: async (s, tool, args) => {
          if (String(args.content).includes('localStorage')) {
            revisions.push(s.revision)
            if (revisions.length === 1)
              return new Promise<Review>((resolve) => {
                release = resolve
              })
          }
          return demoReview(s, tool, args)
        },
      },
    )
    await until(() => !!release)
    const runtime = manager.runtime(state.id)
    runtime.verdict({
      requestId: randomUUID(),
      revision: 1,
      decisionId: state.decisions[0].id,
      action: 'correct',
      text: '只使用页面内存，刷新后清空',
    })
    release(execution)
    await until(() => state.status === 'waiting')
    expect(revisions).toEqual([1, 2])
    expect(state.gates[0].revision).toBe(2)
    expect(runtime.workspace.read('index.html')).not.toContain('localStorage')
    expect(manager.store.events(state.id).some((e) => e.type === 'review.invalidated')).toBe(true)
  })

  it('invalidates checks after a later repair and does not claim generic corrections are verified', async () => {
    const { manager } = setup(),
      state = manager.create(DEMO_PROMPT, 'demo')
    await manager.start(
      state.id,
      state.constraints.map((c) => c.text),
    )
    await until(() => state.status === 'waiting')
    const runtime = manager.runtime(state.id),
      gate = state.gates[0]
    runtime.verdict({
      requestId: randomUUID(),
      revision: 1,
      decisionId: gate.decisionId,
      gateId: gate.id,
      action: 'enforce',
    })
    await until(() => state.status === 'completed')
    const oldChecks = [...state.verifications]
    runtime.verdict({
      requestId: randomUUID(),
      revision: state.revision,
      decisionId: state.decisions[0].id,
      action: 'correct',
      text: '报名名额改为 30 人',
    })
    await until(() => state.status === 'completed' && state.verifications.length > oldChecks.length)
    expect(runtime.workspace.read('index.html')).toContain('共 30 个名额')
    expect(oldChecks.every((c) => c.stale)).toBe(true)
    expect(state.interventions.at(-1)?.progress).toBe('acted')
    expect(state.verifications.filter((c) => !c.stale).every((c) => c.passed)).toBe(true)
  })
})

describe('stored records and bounded workspaces', () => {
  it('recovers a durable correction ahead of its snapshot and never resumes an interrupted tool', async () => {
    const { manager, dir } = setup(),
      state = manager.create(DEMO_PROMPT, 'demo')
    await manager.start(
      state.id,
      state.constraints.map((c) => c.text),
    )
    await until(() => state.status === 'waiting')
    const snapshotPath = path.join(manager.store.directory(state.id), 'state.json')
    const before = readFileSync(snapshotPath, 'utf8'),
      gate = state.gates[0]
    const intervention = {
      id: randomUUID(),
      requestId: randomUUID(),
      decisionId: gate.decisionId,
      stepId: gate.stepId,
      action: 'correct',
      text: '仅内存保存',
      fromRevision: 1,
      toRevision: 2,
      createdAt: new Date().toISOString(),
      progress: 'recorded',
      subsequentStepIds: [],
    }
    manager.store.append(state, 'human.intervention', {
      intervention,
      constraints: state.constraints,
    })
    writeFileSync(snapshotPath, before)
    const restored = new Store(dir).loadAll()[0]
    expect(restored.status).toBe('interrupted')
    expect(restored.revision).toBe(2)
    expect(restored.interventions[0].id).toBe(intervention.id)
    expect(restored.decisions.find((d) => d.id === gate.decisionId)?.humanStatus).toBe('corrected')
    expect(restored.gates.every((g) => g.status !== 'pending')).toBe(true)
    expect(restored.steps.some((s) => s.status === 'executing')).toBe(false)
  })

  it('rejects traversal, absolute paths, Windows aliases and unsupported writes', () => {
    const { dir } = setup(),
      workspace = new Workspace(path.join(dir, 'bounded'))
    for (const file of [
      '../escape.html',
      '/escape.html',
      'C:/escape.html',
      'x\\escape.html',
      'x/../escape.html',
      'CON.html',
      'a.html:secret',
      'a. /b.html',
      'x//b.html',
    ])
      expect(() => workspace.write(file, 'test')).toThrow()
    expect(() => workspace.write('run.exe', 'test')).toThrow()
    expect(() => workspace.write('large.html', 'x'.repeat(250001))).toThrow()
    workspace.write('pages/index.html', '<html>ok</html>')
    expect(workspace.list().map((f) => f.path)).toEqual(['pages/index.html'])
  })

  it('parses persistence references without confusing comments for code and exposes syntax failure', () => {
    expect(inspectHtml('<script>// localStorage.setItem("x", 1)</script>').persistence).toBe(false)
    expect(inspectHtml('<script>window["localStorage"].setItem("x", 1)</script>').persistence).toBe(
      true,
    )
    expect(inspectHtml('<script>let broken = ;</script>').validJavaScript).toBe(false)
  })
})
