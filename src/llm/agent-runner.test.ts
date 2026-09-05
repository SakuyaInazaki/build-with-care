import { describe, expect, it } from 'vitest'
import { DecisionStream } from '../stream.js'
import type { RunnerStatus } from '../runner-types.js'
import { LlmClient, type FetchLike } from './client.js'
import type { LlmProvider } from './config.js'
import { AGENT_TOOLS, ALLOWED_COMMANDS, createLlmRunner, toAction } from './agent-runner.js'

const spec = { id: 's1', request: '做一个待办清单小应用', constraints: ['存储必须使用 Postgres，不允许 SQLite'], confirmed: true }
const executor = { execute: async () => ({ ok: true }) }
type Call = { id: string; name: string; args: Record<string, unknown> }
const openaiCalls = (calls: Call[]) => ({ id: 'r', model: 'fake-agent', choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } }] })
const openaiText = (content: string) => ({ id: 'r', model: 'fake-agent', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] })
const anthropicCalls = (calls: Call[]) => ({ model: 'fake-agent', stop_reason: 'tool_use', content: calls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args })) })

type Body = { messages: Array<{ role: string; content: unknown; tool_call_id?: string }>; tools?: unknown[]; system?: string }
function scripted(responses: unknown[]): { fetch: FetchLike; requests: Body[] } {
  const requests: Body[] = []
  const fetch: FetchLike = async (_, init) => {
    requests.push(JSON.parse(String(init.body)) as Body)
    const next = responses.shift()
    if (next === undefined) throw new Error('fake model has no more responses')
    if (next instanceof Response) return next
    return new Response(JSON.stringify(next), { status: 200 })
  }
  return { fetch, requests }
}
const clientFor = (fetch: FetchLike, provider: LlmProvider = 'openai'): LlmClient => new LlmClient({ role: 'agent', provider, baseUrl: 'https://fake.local/v1', apiKey: 'k', model: 'fake-agent', timeoutMs: 5000 }, { fetch, retries: 0 })
const setup = (mode: 'forward-only' | 'rewind-and-fork' = 'forward-only'): DecisionStream => { const stream = new DecisionStream({ executor, mode }); stream.confirmSpec(spec); return stream }

describe('LlmAgentRunner', () => {
  it('runs decide (blue) → sqlite write (red, human picks alternative) → DENIED fed back → postgres → finish', async () => {
    const { fetch, requests } = scripted([
      openaiCalls([{ id: 'c1', name: 'decide', args: { topic: '缓存方案', choice: '内存缓存', reason: '小项目够用', specified_by_human: false } }]),
      openaiCalls([{ id: 'c2', name: 'write_file', args: { path: 'db.sqlite', content: '', description: '选择 SQLite 存储' } }]),
      openaiCalls([{ id: 'c3', name: 'write_file', args: { path: 'schema.sql', content: 'CREATE TABLE todos (id serial primary key);', description: '写入 Postgres schema' } }]),
      openaiCalls([{ id: 'c4', name: 'finish', args: { summary: '完成：使用 Postgres' } }]),
    ])
    const stream = setup()
    const runner = createLlmRunner(stream, { workspaceRoot: '/sandbox/ws', client: clientFor(fetch), pollIntervalMs: 5 })!
    expect(runner).not.toBeNull(); expect(runner.status).toEqual({ kind: 'llm', state: 'idle', model: 'fake-agent', steps: 0 })
    const states: RunnerStatus['state'][] = []
    const injected = '后续必须使用 Postgres，不允许 SQLite'
    runner.subscribe((status) => { states.push(status.state); if (status.state === 'waiting-human' && status.waitingCardId) stream.decide(status.waitingCardId, { kind: 'alternative', text: injected }) })
    await runner.start()

    expect(runner.status).toMatchObject({ kind: 'llm', state: 'done', steps: 4, message: '完成：使用 Postgres', model: 'fake-agent' })
    expect(runner.status.startedAt).toBeDefined(); expect(runner.status.finishedAt).toBeDefined(); expect(runner.status.waitingCardId).toBeUndefined()
    expect(states.indexOf('running')).toBeGreaterThanOrEqual(0)
    expect(states.indexOf('waiting-human')).toBeGreaterThan(states.indexOf('running'))
    expect(states.at(-1)).toBe('done')

    expect(stream.cards.map((card) => [card.action.tool, card.verdict.kind, card.state])).toEqual([['decide', 'blue', 'allowed'], ['write_file', 'red', 'overridden'], ['write_file', 'blue', 'allowed']])
    expect(stream.cards[1]!.appliedConstraint).toBe(injected)
    expect(stream.spec!.constraints).toContain(injected)
    expect(stream.cards.every((card) => card.agentId === 'llm-agent')).toBe(true)

    expect(requests).toHaveLength(4)
    const first = requests[0]!
    expect(first.messages[0]!.role).toBe('system'); expect(String(first.messages[0]!.content)).toContain('DENIED')
    expect(String(first.messages[1]!.content)).toContain('存储必须使用 Postgres')
    expect(first.tools).toHaveLength(AGENT_TOOLS.length)
    const afterDenial = requests[2]!.messages
    const denied = afterDenial.findIndex((message) => message.role === 'tool' && message.tool_call_id === 'c2')
    expect(denied).toBeGreaterThan(0)
    expect(String(afterDenial[denied]!.content)).toMatch(/^DENIED: /); expect(String(afterDenial[denied]!.content)).toContain(injected)
    const injection = afterDenial.findIndex((message) => message.role === 'user' && String(message.content).includes('人刚刚补充了约束'))
    expect(injection).toBeGreaterThan(denied); expect(String(afterDenial[injection]!.content)).toContain(injected)
    expect(requests[1]!.messages.some((message) => String(message.content).includes('人刚刚补充了约束'))).toBe(false)
    expect(requests[3]!.messages.filter((message) => String(message.content).includes('人刚刚补充了约束'))).toHaveLength(1)
  })

  it('cancel() aborts the in-flight model call and settles as cancelled', async () => {
    const hang: FetchLike = (_, init) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    const runner = createLlmRunner(setup(), { workspaceRoot: '/sandbox/ws', client: clientFor(hang) })!
    const finished = runner.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(runner.status.state).toBe('running')
    runner.cancel('人叫停了')
    await finished
    expect(runner.status).toMatchObject({ state: 'cancelled', message: '人叫停了' })
  })

  it('cancel() while a red card is pending releases the gate', async () => {
    const { fetch } = scripted([openaiCalls([{ id: 'c1', name: 'write_file', args: { path: 'db.sqlite', content: '', description: '选择 SQLite 存储' } }])])
    const stream = setup()
    const runner = createLlmRunner(stream, { workspaceRoot: '/sandbox/ws', client: clientFor(fetch), pollIntervalMs: 5 })!
    const finished = runner.start()
    await new Promise<void>((resolve) => runner.subscribe((status) => { if (status.state === 'waiting-human') resolve() }))
    runner.cancel()
    await finished
    expect(runner.status.state).toBe('cancelled'); expect(stream.cards[0]!.state).toBe('cancelled')
  })

  it('stops at maxSteps without calling the model again', async () => {
    const { fetch, requests } = scripted([openaiCalls([{ id: 'c1', name: 'decide', args: { topic: 'a', choice: 'b', reason: 'c' } }]), openaiCalls([{ id: 'c2', name: 'decide', args: { topic: 'd', choice: 'e', reason: 'f' } }])])
    const runner = createLlmRunner(setup(), { workspaceRoot: '/sandbox/ws', client: clientFor(fetch), maxSteps: 1 })!
    await runner.start()
    expect(runner.status).toMatchObject({ state: 'done', steps: 1 }); expect(runner.status.message).toContain('最大步数'); expect(requests).toHaveLength(1)
  })

  it('nudges text-only replies, rejects disallowed commands and unknown tools without touching the stream', async () => {
    const { fetch, requests } = scripted([
      openaiText('我打算先看看'),
      openaiCalls([{ id: 'c1', name: 'run_command', args: { command: 'rm -rf /' } }, { id: 'c2', name: 'teleport', args: {} }]),
      openaiCalls([{ id: 'c3', name: 'run_command', args: { command: 'node --version' } }]),
      openaiCalls([{ id: 'c4', name: 'finish', args: { summary: '好了' } }]),
    ])
    const stream = setup()
    const runner = createLlmRunner(stream, { workspaceRoot: '/sandbox/ws', client: clientFor(fetch), agentId: 'coder' })!
    await runner.start()
    expect(runner.status).toMatchObject({ state: 'done', steps: 4, message: '好了' })
    expect(String(requests[1]!.messages.at(-1)!.content)).toContain('请通过工具调用继续')
    const results = requests[2]!.messages.filter((message) => message.role === 'tool')
    expect(String(results[0]!.content)).toContain(`ERROR: 命令不在允许列表内，只允许：${ALLOWED_COMMANDS.join(' / ')}`)
    expect(String(results[1]!.content)).toContain('ERROR: 未知工具 teleport')
    expect(stream.cards.map((card) => [card.agentId, card.action.tool, card.verdict.kind])).toEqual([['coder', 'run_command', 'blue']])
    expect(String(requests[3]!.messages.at(-1)!.content)).toContain('OK: 命令已执行')
  })

  it('speaks the Anthropic protocol end to end', async () => {
    const { fetch, requests } = scripted([
      anthropicCalls([{ id: 't1', name: 'write_file', args: { path: 'README.md', content: '# todo', description: '写 README', specified_by_human: true } }]),
      anthropicCalls([{ id: 't2', name: 'finish', args: { summary: '完成' } }]),
    ])
    const stream = setup()
    const runner = createLlmRunner(stream, { workspaceRoot: '/sandbox/ws', client: clientFor(fetch, 'anthropic') })!
    await runner.start()
    expect(runner.status).toMatchObject({ state: 'done', steps: 2, message: '完成' })
    expect(stream.cards[0]!.verdict.kind).toBe('blue'); expect(stream.cards[0]!.action.specified).toBe(true)
    const second = requests[1]!
    expect(second.system).toContain('DENIED'); expect((second.tools![0] as { input_schema: unknown }).input_schema).toBeDefined()
    expect(second.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
    expect(second.messages[2]!.content).toEqual([{ type: 'tool_result', tool_use_id: 't1', content: 'OK: 已写入 README.md' }])
  })

  it('fails closed on model errors and on a missing spec, and returns null when unconfigured', async () => {
    const { fetch } = scripted([new Response('{"error":"boom"}', { status: 500 })])
    const failed = createLlmRunner(setup(), { workspaceRoot: '/sandbox/ws', client: clientFor(fetch) })!
    await failed.start()
    expect(failed.status.state).toBe('failed'); expect(failed.status.message).toContain('HTTP 500')
    const noSpec = createLlmRunner(new DecisionStream({ executor }), { workspaceRoot: '/sandbox/ws', client: clientFor(fetch) })!
    await noSpec.start()
    expect(noSpec.status.state).toBe('failed'); expect(noSpec.status.message).toContain('spec')
    expect(createLlmRunner(setup(), { workspaceRoot: '/sandbox/ws', config: { agent: null, judge: null, recorder: null } })).toBeNull()
  })

  it('toAction maps tools onto stream actions and honours specified_by_human', () => {
    expect(toAction({ id: 'x', name: 'decide', args: { topic: '存储', choice: 'Postgres', reason: '约束要求', specified_by_human: true } }, 'a')).toEqual({ tool: 'decide', kind: 'write', description: '决定存储：Postgres', args: { topic: '存储', choice: 'Postgres', reason: '约束要求' }, specified: true, agentId: 'a' })
    expect(toAction({ id: 'x', name: 'validate', args: { target: 'schema.sql' } }, 'a')).toMatchObject({ kind: 'validate', description: '检查 schema.sql', specified: false })
    expect(toAction({ id: 'x', name: 'read_file', args: { path: 'a.ts', specified_by_human: 'true' } }, 'a')).toMatchObject({ kind: 'read', specified: false })
    expect(toAction({ id: 'x', name: 'nope', args: {} }, 'a')).toBeNull()
    expect(AGENT_TOOLS.filter((tool) => tool.name !== 'finish').every((tool) => 'specified_by_human' in (tool.parameters.properties as Record<string, unknown>))).toBe(true)
  })
})
