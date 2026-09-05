import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DEMO_PROMPT, type Review } from '../shared/types.js'
import { demoReview } from '../server/reviewer.js'
import { Store } from '../server/store.js'
import { Manager } from '../server/manager.js'
import { LlmAdapter, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { responseChunks } from '../server/models.js'
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
  it.each([
    { oldText: 'missing', file: 'index.html', error: '匹配 0 次' },
    { oldText: 'same', file: 'index.html', error: '匹配 2 次' },
    { oldText: '', file: 'index.html', error: 'oldText 不能为空' },
    { oldText: 'same', file: 'missing.html', error: 'ENOENT' },
  ])(
    'returns invalid edit $error to the worker for repair without review retry',
    async ({ oldText, file, error }) => {
      const { manager } = setup(),
        state = manager.create(DEMO_PROMPT, 'demo')
      const workspace = new Workspace(path.join(manager.store.directory(state.id), 'workspace'))
      const original = '<p>same</p><b>same</b>'
      workspace.write('index.html', original)
      const replacement = "<p>$& $$ $` $' repaired</p>"
      let requests = 0
      const reviewed: string[] = []
      await manager.start(
        state.id,
        state.constraints.map((c) => c.text),
        {
          reviewer: async (_run, tool, args) => {
            reviewed.push(tool)
            if (tool === 'edit_file') expect(args.content).toBe(replacement + '<b>same</b>')
            return execution
          },
          adapter: (onRequest) =>
            new (class extends LlmAdapter {
              async *stream(options: GenerateOptions) {
                onRequest(options)
                requests++
                if (requests === 2) {
                  expect(JSON.stringify(options.messages)).toContain(error)
                  expect(workspace.read('index.html')).toBe(original)
                  expect(reviewed).toEqual([])
                  expect(state.reviewFailure).toBeUndefined()
                }
                const call =
                  requests === 1
                    ? {
                        name: 'edit_file',
                        arguments: { path: file, oldText, newText: 'wrong', intent: 'edit' },
                      }
                    : requests === 2
                      ? { name: 'read_file', arguments: { path: 'index.html' } }
                      : {
                          name: 'edit_file',
                          arguments: {
                            path: 'index.html',
                            oldText: '<p>same</p>',
                            newText: replacement,
                            intent: 'repair',
                          },
                        }
                yield* responseChunks({
                  content: '',
                  calls:
                    requests <= 3
                      ? [
                          {
                            id: randomUUID(),
                            name: call.name,
                            arguments: JSON.stringify(call.arguments),
                          },
                        ]
                      : [],
                  finishReason: requests <= 3 ? 'tool_calls' : 'stop',
                })
              }
            })(),
        },
      )
      await until(() => state.status === 'completed')
      expect(state.steps.map((s) => s.status)).toEqual(['failed', 'done', 'done'])
      expect(workspace.read('index.html')).toBe(replacement + '<b>same</b>')
      expect(reviewed).toEqual(['read_file', 'edit_file'])
      expect(state.reviewFailure).toBeUndefined()
      expect(state.gates).toHaveLength(0)
      expect(state.decisions).toHaveLength(0)
      expect(state.revision).toBe(1)
      expect(manager.store.events(state.id).some((e) => e.type === 'review.failed')).toBe(false)
    },
  )

  it('returns a stale recovered edit to the worker without retrying the reviewer', async () => {
    const f = setup(),
      original = f.manager.create(DEMO_PROMPT, 'demo')
    const workspace = new Workspace(path.join(f.manager.store.directory(original.id), 'workspace'))
    workspace.write('index.html', 'before')
    await f.manager.start(
      original.id,
      original.constraints.map((c) => c.text),
      {
        reviewer: async () => {
          throw new Error('连接中断')
        },
        adapter: (onRequest) =>
          new (class extends LlmAdapter {
            async *stream(options: GenerateOptions) {
              onRequest(options)
              yield* responseChunks({
                content: '',
                calls: [
                  {
                    id: randomUUID(),
                    name: 'edit_file',
                    arguments: JSON.stringify({
                      path: 'index.html',
                      oldText: 'before',
                      newText: 'after',
                      intent: 'edit',
                    }),
                  },
                ],
                finishReason: 'tool_calls',
              })
            }
          })(),
      },
    )
    await until(() => !!original.reviewFailure)
    const pending = structuredClone(original.steps[0])
    await f.manager.dispose()
    workspace.write('index.html', 'changed in the meantime')
    const manager = new Manager(f.dir, f.manager.settings)
    try {
      const state = manager.get(original.id),
        constraints = structuredClone(state.constraints)
      let reviews = 0,
        requests = 0
      await manager.resume(
        state.id,
        { requestId: randomUUID(), revision: state.revision },
        {
          reviewer: async () => {
            reviews++
            return execution
          },
          adapter: (onRequest) =>
            new (class extends LlmAdapter {
              async *stream(options: GenerateOptions) {
                onRequest(options)
                requests++
                expect(JSON.stringify(options.messages)).toContain('匹配 0 次')
                yield* responseChunks({
                  content: '已收到编辑错误，将依据最新文件修正',
                  calls: [],
                  finishReason: 'stop',
                })
              }
            })(),
        },
      )
      await until(() => state.status === 'completed')
      expect(reviews).toBe(0)
      expect(requests).toBe(1)
      expect(state.steps[0].id).toBe(pending.id)
      expect(state.steps[0].args).toEqual(pending.args)
      expect(state.steps[0].status).toBe('failed')
      expect(state.reviewFailure).toBeUndefined()
      expect(state.constraints).toEqual(constraints)
      expect(workspace.read('index.html')).toBe('changed in the meantime')
    } finally {
      await manager.dispose()
    }
  })

  it('keeps a slow review alive past the threshold without releasing the action', async () => {
    const { manager } = setup({ reviewTimeoutMs: 30 }),
      state = manager.create(DEMO_PROMPT, 'demo')
    let release!: (review: Review) => void
    const review = new Promise<Review>((resolve) => {
      release = resolve
    })
    await manager.start(
      state.id,
      state.constraints.map((c) => c.text),
      { reviewer: () => review },
    )
    await until(() => state.modelProgress?.phase === 'review-slow')
    expect(state.status).toBe('running')
    expect(state.files).toHaveLength(0)
    expect(state.decisions).toHaveLength(0)
    expect(state.gates).toHaveLength(0)
    release(execution)
    await until(() => state.status === 'completed')
    expect(state.files.length).toBeGreaterThan(0)
    expect(state.modelProgress).toBeUndefined()
  })

  it('retries a failed review in place with unchanged arguments and no additional requirement', async () => {
    const { manager } = setup(),
      state = manager.create(DEMO_PROMPT, 'demo')
    let calls = 0
    await manager.start(
      state.id,
      state.constraints.map((c) => c.text),
      {
        reviewer: async () => {
          if (++calls === 1) throw new Error('连接中断')
          return execution
        },
      },
    )
    await until(() => !!state.reviewFailure)
    const firstStep = structuredClone(state.steps[0])
    const constraints = structuredClone(state.constraints)
    const revision = state.revision
    const runtime = manager.runtime(state.id)
    expect(state.status).toBe('running')
    expect(state.gates).toHaveLength(0)
    expect(state.files).toHaveLength(0)
    expect(manager.store.events(state.id).filter((e) => e.type === 'model.request')).toHaveLength(1)
    const input = { requestId: randomUUID(), revision, stepId: firstStep.id }
    expect(() =>
      runtime.retryReview({ ...input, revision: revision + 1 }, manager.settings),
    ).toThrow('要求已更新')
    runtime.retryReview(input, manager.settings)
    runtime.retryReview(input, manager.settings)
    await until(() => state.status === 'completed')
    expect(state.steps.filter((s) => s.id === firstStep.id)).toHaveLength(1)
    expect(state.steps[0].args).toEqual(firstStep.args)
    expect(state.steps[0].status).toBe('done')
    expect(state.constraints).toEqual(constraints)
    expect(state.revision).toBe(revision)
    expect(state.reviewFailure).toBeUndefined()
    expect(
      manager.store.events(state.id).filter((e) => e.type === 'review.retry-requested'),
    ).toHaveLength(1)
  })

  it('stops immediately while awaiting a failed review retry', async () => {
    const { manager } = setup(),
      state = manager.create(DEMO_PROMPT, 'demo')
    await manager.start(
      state.id,
      state.constraints.map((c) => c.text),
      {
        reviewer: async () => {
          throw new Error('连接中断')
        },
      },
    )
    await until(() => !!state.reviewFailure)
    manager.runtime(state.id).requestStop()
    await until(() => state.status === 'stopped', 1500)
    expect(state.files).toHaveLength(0)
    expect(state.reviewFailure).toBeUndefined()
    expect(state.steps[0].status).toBe('cancelled')
  })

  it('rechecks the identical unexecuted action after a service restart before requesting the worker', async () => {
    const f = setup(),
      original = f.manager.create(DEMO_PROMPT, 'demo')
    await f.manager.start(
      original.id,
      original.constraints.map((c) => c.text),
      {
        reviewer: async () => {
          throw new Error('证据格式不完整')
        },
      },
    )
    await until(() => !!original.reviewFailure)
    const pending = structuredClone(original.steps[0])
    await f.manager.dispose()
    const manager = new Manager(f.dir, f.manager.settings)
    try {
      const state = manager.get(original.id)
      const before = state.lastEventSeq
      let release!: (review: Review) => void
      const reviewing = new Promise<Review>((resolve) => {
        release = resolve
      })
      let workerRequests = 0
      await manager.resume(
        state.id,
        { requestId: randomUUID(), revision: state.revision },
        {
          reviewer: async (_run, tool, args) => {
            expect(tool).toBe(pending.tool)
            expect(args).toEqual(pending.args)
            return reviewing
          },
          adapter: (onRequest) =>
            new (class extends LlmAdapter {
              async *stream(options: GenerateOptions) {
                workerRequests++
                onRequest(options)
                yield* responseChunks({
                  content: '继续核验现有成果',
                  calls: [],
                  finishReason: 'stop',
                })
              }
            })(),
        },
      )
      await until(() => state.steps[0].status === 'reviewing')
      expect(workerRequests).toBe(0)
      expect(state.files).toHaveLength(0)
      expect(state.steps).toHaveLength(1)
      expect(state.steps[0].id).toBe(pending.id)
      release({
        ...execution,
        classification: 'conflict',
        constraintIds: [state.constraints[0].id],
        evidence: '拟写入代码与要求冲突',
      })
      await until(() => state.status === 'waiting')
      expect(state.files).toHaveLength(0)
      expect(workerRequests).toBe(0)
      const gate = state.gates.at(-1)!
      manager.runtime(state.id).verdict({
        requestId: randomUUID(),
        revision: state.revision,
        decisionId: gate.decisionId,
        gateId: gate.id,
        action: 'allow-once',
      })
      await until(() => state.status === 'completed')
      expect(state.steps[0].status).toBe('done')
      expect(state.steps[0].args).toEqual(pending.args)
      expect(workerRequests).toBe(1)
      const events = manager.store.events(state.id, before)
      expect(events.findIndex((e) => e.type === 'tool.finished')).toBeLessThan(
        events.findIndex((e) => e.type === 'model.request'),
      )
      expect(state.constraints).toEqual(original.constraints)
      expect(state.revision).toBe(original.revision)
    } finally {
      await manager.dispose()
    }
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
