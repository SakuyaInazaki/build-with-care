import { afterEach, expect, it } from 'vitest'
import { LlmAdapter, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { fixture, until } from './helpers.js'
import { responseChunks } from '../server/models.js'
import { DecisionRuntime } from '../server/engine.js'
import {
  activeUnit,
  cancelUnits,
  checkUnitScope,
  closeUnit,
  declareUnit,
  unitPolicy,
} from '../server/work-units.js'
import type { Review } from '../shared/types.js'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup()
})
const execution: Review = {
  classification: 'execution',
  title: '执行单元',
  summary: '按声明执行',
  impact: '',
  constraintIds: [],
  evidence: '',
  options: [],
  topic: 'unit-test',
  source: 'system',
}
function setup() {
  const config = { baseUrl: 'http://127.0.0.1:4999', apiKey: '', model: 'test', family: 'test' }
  const f = fixture({ worker: config, reviewer: config })
  fixtures.push(f)
  return { ...f, state: f.manager.create('构建一个中文页面', 'live') }
}
const begin = (path = 'index.html') => ({
  goal: '实现页面内容',
  decisions: [],
  plan: [{ tool: 'write_file', path }],
})
const html = '<html><head><title>页面</title></head><body>内容</body></html>'
const tools = ['write_file', 'edit_file', 'read_file', 'verify_app', 'list_files']

it('enforces declarations, ordered scope, explicit closure and cancellation', () => {
  const { state } = setup()
  expect(state.workUnitProtocol).toBe(true)
  expect(() => checkUnitScope(state, 'write_file', { path: 'index.html' })).toThrow('begin_unit')
  expect(checkUnitScope(state, 'read_file', { path: 'index.html' })).toBeUndefined()
  expect(() =>
    declareUnit(state, { ...begin(), plan: [{ tool: 'ask_user_question' }] }, [
      ...tools,
      'ask_user_question',
    ]),
  ).toThrow('不可用')
  const unit = declareUnit(state, begin(), tools)
  expect(() => declareUnit(state, begin(), tools)).toThrow('尚未结束')
  expect(() => checkUnitScope(state, 'write_file', { path: 'index.html' })).toThrow('尚未通过')
  unit.status = 'active'
  expect(() => checkUnitScope(state, 'edit_file', { path: 'index.html' })).toThrow('超出')
  expect(() => checkUnitScope(state, 'write_file', { path: 'other.html' })).toThrow('超出')
  expect(checkUnitScope(state, 'write_file', { path: 'index.html' })?.id).toBe(unit.id)
  unit.decisions = [{ domain: 'storage', choice: 'postgres' }]
  expect(() =>
    checkUnitScope(state, 'write_file', { path: 'index.html', content: 'sqlite' }),
  ).toThrow('声明不一致')
  expect(() => closeUnit(state, '完成')).toThrow('未完成')
  closeUnit(state, '取消原计划', true)
  expect(activeUnit(state)).toBeUndefined()
  const next = declareUnit(state, begin(), tools)
  expect(next.id).not.toBe(unit.id)
  cancelUnits(state)
  expect(activeUnit(state)).toBeUndefined()
})

it('reuses the legacy deterministic constraint floor without trusting human-specified claims', () => {
  const { state } = setup()
  state.constraints[0].text = '必须使用 Postgres；禁止 SQLite'
  const unit = declareUnit(
    state,
    { ...begin(), decisions: [{ domain: 'storage', choice: 'sqlite', specifiedByHuman: true }] },
    tools,
  )
  const review = unitPolicy(state, 'begin_unit', {}, unit)!
  expect(review.classification).toBe('conflict')
  expect(review.constraintIds).toEqual([state.constraints[0].id])
  expect(review.source).toBe('system')
  expect(review.evidence).toContain('sqlite')
})

it('runs declaration, scoped writes and closing through the real dsh tool pipeline', async () => {
  const { manager, state } = setup()
  const sequence = [
    {
      name: 'write_file',
      arguments: { path: 'index.html', content: 'must not write', intent: 'undeclared' },
    },
    { name: 'begin_unit', arguments: begin() },
    {
      name: 'write_file',
      arguments: { path: 'elsewhere.html', content: 'must not write', intent: 'out of scope' },
    },
    {
      name: 'write_file',
      arguments: { path: 'index.html', content: html, intent: 'implement unit' },
    },
    { name: 'end_unit', arguments: { summary: '已写入页面' } },
  ]
  let request = 0
  await manager.start(
    state.id,
    state.constraints.map((c) => c.text),
    {
      reviewer: async () => execution,
      adapter: (onRequest) =>
        new (class extends LlmAdapter {
          async *stream(options: GenerateOptions) {
            onRequest(options)
            const call = sequence[request++]
            yield* responseChunks({
              content: '',
              calls: call
                ? [{ id: randomUUID(), name: call.name, arguments: JSON.stringify(call.arguments) }]
                : [],
              finishReason: call ? 'tool_calls' : 'stop',
            })
          }
        })(),
    },
  )
  await until(() => state.status === 'completed' || state.status === 'error')
  expect(state.error).toBeUndefined()
  expect(state.steps.map((s) => s.status)).toEqual(['failed', 'done', 'failed', 'done', 'done', 'done'])
  expect(state.steps.at(-1)?.tool).toBe('verify_app')
  expect(state.verifications.every(check => check.passed)).toBe(true)
  expect(state.files.map((f) => f.path)).toEqual(['index.html'])
  expect(manager.runtime(state.id).workspace.read('index.html')).toBe(html)
  expect(state.workUnits?.[0].status).toBe('completed')
  expect(state.workUnits?.[0].nextCall).toBe(1)
  expect(state.steps[3].unitId).toBe(state.workUnits?.[0].id)
  expect(state.revision).toBe(1)
  expect(state.reviewFailure).toBeUndefined()
})

it('continues beyond 30 model requests without an artificial execution cutoff', async () => {
  const { manager, state } = setup()
  let requests = 0
  await manager.start(state.id, ['查看工作区'], {
    adapter: onRequest => new (class extends LlmAdapter {
      async *stream(options: GenerateOptions) {
        onRequest(options)
        requests++
        yield* responseChunks({ content: '', calls: requests <= 35 ? [{ id: randomUUID(), name: 'list_files', arguments: '{}' }] : [], finishReason: requests <= 35 ? 'tool_calls' : 'stop' })
      }
    })(),
  })
  await until(() => ['completed', 'error'].includes(state.status), 15000)
  expect(state.status).toBe('completed')
  expect(state.error).toBeUndefined()
  expect(requests).toBe(36)
  expect(state.steps).toHaveLength(35)
  expect(manager.store.events(state.id).filter(event => event.type === 'model.request')).toHaveLength(36)
}, 20000)

it('checks changed files at unit close and requires repair after a failed check', async () => {
  const { manager, state } = setup()
  const calls = [
    { name: 'begin_unit', arguments: begin() },
    { name: 'write_file', arguments: { path: 'index.html', content: '<html><head><title>X</title></head><body><script>let = ;</script></body></html>', intent: 'write' } },
    { name: 'end_unit', arguments: { summary: 'should not close' } },
    { name: 'end_unit', arguments: { summary: 'prepare repair', cancelled: true } },
    { name: 'begin_unit', arguments: begin() },
    { name: 'write_file', arguments: { path: 'index.html', content: html, intent: 'repair syntax' } },
    { name: 'end_unit', arguments: { summary: 'repaired' } },
  ]
  let request = 0
  await manager.start(state.id, ['构建页面'], {
    reviewer: async () => execution,
    adapter: onRequest => new (class extends LlmAdapter {
      async *stream(options: GenerateOptions) {
        onRequest(options)
        const call = calls[request++]
        yield* responseChunks({ content: '', calls: call ? [{ id: randomUUID(), name: call.name, arguments: JSON.stringify(call.arguments) }] : [], finishReason: call ? 'tool_calls' : 'stop' })
      }
    })(),
  })
  await until(() => ['completed', 'error'].includes(state.status))
  expect(state.status).toBe('completed')
  expect(state.steps.find(step => step.tool === 'end_unit')?.status).toBe('failed')
  expect(state.workUnits?.map(unit => unit.status)).toEqual(['cancelled', 'completed'])
  expect(state.verifications.some(check => !check.passed)).toBe(true)
  expect(state.verifications.filter(check => !check.stale).every(check => check.passed)).toBe(true)
})

it('refreshes stopped task checks without resuming execution and parses each supported file type', () => {
  const { manager, state } = setup()
  const runtime = new DecisionRuntime(state, manager.store, manager.settings, () => {})
  for (const [file, content] of [['index.html', html], ['app.js', 'const x = 1'], ['style.css', 'body { color: red }'], ['data.json', '{"x":1}']]) runtime.workspace.write(file, content)
  state.files = runtime.workspace.list()
  state.status = 'error'
  state.error = 'original failure'
  const input = { requestId: randomUUID(), revision: state.revision }
  manager.verifyArtifacts(state.id, input)
  expect(state.status).toBe('error')
  expect(state.error).toBe('original failure')
  expect(state.verifications.every(check => check.passed)).toBe(true)
  expect(state.steps).toHaveLength(4)
  manager.verifyArtifacts(state.id, input)
  expect(state.steps).toHaveLength(4)
  expect(manager.store.events(state.id).some(event => event.type === 'model.request')).toBe(false)
})

it('blocks a rule conflict even when the injected semantic reviewer allows it', async () => {
  const { manager, state } = setup()
  const declaration = { ...begin(), decisions: [{ domain: 'storage', choice: 'sqlite' }] }
  await manager.start(state.id, ['必须使用 Postgres；禁止 SQLite'], {
    reviewer: async () => execution,
    adapter: (onRequest) =>
      new (class extends LlmAdapter {
        async *stream(options: GenerateOptions) {
          onRequest(options)
          yield* responseChunks({
            content: '',
            calls: [
              { id: randomUUID(), name: 'begin_unit', arguments: JSON.stringify(declaration) },
            ],
            finishReason: 'tool_calls',
          })
        }
      })(),
  })
  await until(() => state.status === 'waiting')
  expect(state.decisions[0].review.classification).toBe('conflict')
  expect(state.files).toHaveLength(0)
  expect(state.workUnits?.[0].status).toBe('declared')
  manager.runtime(state.id).requestStop()
  await until(() => state.status === 'stopped')
  expect(state.workUnits?.[0].status).toBe('cancelled')
})

it('executes the merged command tool inside its declared unit without fabricating verification', async () => {
  const { manager, state } = setup()
  const sequence = [
    {
      name: 'begin_unit',
      arguments: { goal: '检查 Node 环境', decisions: [], plan: [{ tool: 'run_command' }] },
    },
    { name: 'run_command', arguments: { command: 'node --version', intent: '读取实际 Node 版本' } },
    { name: 'end_unit', arguments: { summary: '完成版本查询' } },
  ]
  let request = 0
  await manager.start(
    state.id,
    state.constraints.map((c) => c.text),
    {
      reviewer: async () => execution,
      adapter: (onRequest) =>
        new (class extends LlmAdapter {
          async *stream(options: GenerateOptions) {
            onRequest(options)
            const call = sequence[request++]
            yield* responseChunks({
              content: '',
              calls: call
                ? [{ id: randomUUID(), name: call.name, arguments: JSON.stringify(call.arguments) }]
                : [],
              finishReason: call ? 'tool_calls' : 'stop',
            })
          }
        })(),
    },
  )
  await until(() => ['completed', 'error'].includes(state.status))
  expect(state.error).toBeUndefined()
  expect(state.steps[1].status).toBe('done')
  expect(state.steps[1].result).toContain(process.version)
  expect(state.steps[1].externalSideEffect).toBe(true)
  expect(state.verifications).toHaveLength(0)
  expect(state.workUnits?.[0].status).toBe('completed')
})
