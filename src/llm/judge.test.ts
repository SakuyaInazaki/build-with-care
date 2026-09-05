import { describe, expect, it } from 'vitest'
import type { ActionInput, RecorderInput } from '../types.js'
import { LlmClient, type FetchLike } from './client.js'
import type { LlmRoleConfig } from './config.js'
import { FALLBACK_NAME, LlmJudge, LlmRecorder, createLlmJudge, createLlmRecorder, parseAssessment, parseVerdict, renderJudgeInput, renderRecorderInput } from './judge.js'

const roleConfig: LlmRoleConfig = { role: 'judge', provider: 'openai', baseUrl: 'https://gw.example.com/v1', apiKey: 'sk-test', model: 'claude-opus-5', timeoutMs: 5000 }
const reply = (content: string, status = 200): Response => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }), { status })
const clientWith = (fetch: FetchLike): LlmClient => new LlmClient(roleConfig, { fetch, retries: 0 })
const spec = { id: 's1', request: '做数据库功能', constraints: ['存储必须使用 Postgres，不允许 SQLite'], confirmed: true }
const action = (overrides: Partial<ActionInput> = {}): ActionInput => ({ tool: 'write_file', kind: 'write', description: '选择 SQLite 存储', args: { path: 'db.sqlite' }, ...overrides })
const identity = { sessionId: 's', branchId: 'main', agentId: 'a', turn: 1, step: 1 }

describe('LlmJudge', () => {
  it('returns the model verdict and reports llm provenance', async () => {
    const seen: string[] = []
    const judge = new LlmJudge(clientWith(async (_, init) => { seen.push(String(init.body)); return reply('{"kind":"red","explanation":"与约束冲突","alternatives":["改用 Postgres"],"failureKind":"constraint-conflict"}') }))
    expect(judge.name).toBe('llm:claude-opus-5'); expect(judge.lastSource).toBe('none')
    const verdict = await judge.judge({ spec, action: action() })
    expect(verdict).toEqual({ kind: 'red', explanation: '与约束冲突', alternatives: ['改用 Postgres', '按已确认 spec 执行'], failureKind: 'constraint-conflict' })
    expect(judge.name).toBe('llm:claude-opus-5'); expect(judge.lastSource).toBe('llm')
    const body = JSON.parse(seen[0]!) as { messages: Array<{ role: string; content: string }> }
    expect(body.messages[0]!.content).toContain('判官'); expect(body.messages[1]!.content).toContain('存储必须使用 Postgres'); expect(body.messages[1]!.content).toContain('db.sqlite')
  })

  it('falls back to the deterministic judge on garbage output and flips name for that call only', async () => {
    let good = false
    const judge = new LlmJudge(clientWith(async () => reply(good ? '{"kind":"blue","explanation":"自选","alternatives":["a","b"]}' : '我觉得挺好的，没有 JSON')))
    const fallback = await judge.judgeWithSource({ spec, action: action() })
    expect(fallback.source).toBe('fallback'); expect(fallback.verdict.kind).toBe('red'); expect(fallback.error).toContain('JSON')
    expect(judge.name).toBe(FALLBACK_NAME); expect(judge.lastSource).toBe('fallback'); expect(judge.lastError).toBeDefined()
    good = true
    const recovered = await judge.judgeWithSource({ spec, action: action({ description: '选择缓存方案', args: { provider: 'memory' } }) })
    expect(recovered).toEqual({ verdict: { kind: 'blue', explanation: '自选', alternatives: ['a', 'b'] }, source: 'llm' })
    expect(judge.name).toBe('llm:claude-opus-5'); expect(judge.lastError).toBeUndefined()
  })

  it('falls back on transport failures and on invalid kinds', async () => {
    const down = new LlmJudge(clientWith(async () => reply('{}', 500)))
    expect((await down.judgeWithSource({ spec, action: action({ kind: 'read', specified: true }) })).source).toBe('fallback')
    expect(down.name).toBe(FALLBACK_NAME)
    const weird = new LlmJudge(clientWith(async () => reply('{"kind":"purple","explanation":"?"}')))
    expect((await weird.judgeWithSource({ spec, action: action() })).source).toBe('fallback')
  })

  it('parseVerdict normalizes kinds, alternatives and failureKind', () => {
    expect(parseVerdict({ kind: '红色', explanation: 'x', alternatives: ['a', 'b', 'c', 'd'] })).toEqual({ kind: 'red', explanation: 'x', alternatives: ['a', 'b', 'c'], failureKind: 'constraint-conflict' })
    expect(parseVerdict({ kind: 'GRAY', explanation: 'x', alternatives: ['ignored'] })).toEqual({ kind: 'gray', explanation: 'x', alternatives: [] })
    expect(parseVerdict({ kind: 'blue', explanation: ' 自选 ' })).toEqual({ kind: 'blue', explanation: '自选', alternatives: ['保留当前选择', '补充一条后续约束'] })
    expect(() => parseVerdict({ kind: 'blue' })).toThrow('explanation')
    expect(() => parseVerdict('blue')).toThrow()
  })

  it('renderJudgeInput truncates large args and flags the self-reported specified claim', () => {
    const text = renderJudgeInput({ spec, action: action({ specified: true, args: { path: 'a.ts', content: 'x'.repeat(5000) } }) })
    expect(text).toContain('是（需核实）'); expect(text).toContain('已截断'); expect(text.length).toBeLessThan(3000)
  })
})

describe('LlmRecorder', () => {
  const input = (overrides: Partial<RecorderInput> = {}): RecorderInput => ({ ...identity, humanInstruction: '不要用 SQLite', action: action(), ...overrides })

  it('parses assessments and includes spec context from the provider', async () => {
    const seen: string[] = []
    const recorder = new LlmRecorder(clientWith(async (_, init) => { seen.push(String(init.body)); return reply('{"selfDirected":true,"deviatesFromInstruction":"true","note":"违反禁令","confidence":1.7}') }), { context: () => ({ request: '做数据库', constraints: ['只用 Postgres'], lastAdjudication: '改用 Postgres' }) })
    expect(await recorder.assess(input())).toEqual({ selfDirected: true, deviatesFromInstruction: true, drift: true, note: '违反禁令', confidence: 1 })
    expect(recorder.name).toBe('llm:claude-opus-5')
    const prompt = (JSON.parse(seen[0]!) as { messages: Array<{ content: string }> }).messages[1]!.content
    expect(prompt).toContain('只用 Postgres'); expect(prompt).toContain('改用 Postgres'); expect(prompt).toContain('不要用 SQLite')
  })

  it('falls back to the deterministic recorder on garbage', async () => {
    const recorder = new LlmRecorder(clientWith(async () => reply('无法判断')))
    const result = await recorder.assessWithSource(input())
    expect(result.source).toBe('fallback'); expect(result.assessment.drift).toBe(true); expect(recorder.name).toBe(FALLBACK_NAME)
    expect(renderRecorderInput(input({ humanInstruction: undefined }))).toContain('（人没有给出明确指令）')
  })

  it('parseAssessment validates and defaults', () => {
    expect(parseAssessment({ selfDirected: false, deviatesFromInstruction: false, confidence: 'high' })).toEqual({ selfDirected: false, deviatesFromInstruction: false, drift: false, note: '动作来自明确指令', confidence: 0.5 })
    expect(parseAssessment({ selfDirected: true, drift: false, note: 'n', confidence: 0.3 })).toMatchObject({ selfDirected: true, drift: false, note: 'n', confidence: 0.3 })
    expect(() => parseAssessment({ selfDirected: 'maybe' })).toThrow()
  })
})

describe('factories', () => {
  it('return null when the role is not configured and instances when it is', () => {
    const empty = { agent: null, judge: null, recorder: null }
    expect(createLlmJudge({ config: empty })).toBeNull(); expect(createLlmRecorder({ config: empty })).toBeNull()
    const configured = { agent: null, judge: roleConfig, recorder: { ...roleConfig, role: 'recorder' as const, model: 'claude-sonnet-5' } }
    expect(createLlmJudge({ config: configured })?.name).toBe('llm:claude-opus-5')
    expect(createLlmRecorder({ config: configured })?.name).toBe('llm:claude-sonnet-5')
  })
})
