import { describe, expect, it } from 'vitest'
import { DecisionStream } from './stream.js'
import type { ActionInput } from './types.js'
import { mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const spec = { id: 's1', request: '做数据库功能', constraints: ['存储必须使用 Postgres，不允许 SQLite'], confirmed: true }
const action = (overrides: Partial<ActionInput> = {}): ActionInput => ({ tool: 'write_file', kind: 'write', description: '选择 SQLite 存储', args: { path: 'db.sqlite' }, ...overrides })

describe('Decision Stream governance', () => {
  it('blocks red cards until allow', async () => {
    const stream = new DecisionStream(); stream.confirmSpec(spec)
    let finished = false; const pending = stream.execute(action()).then((result) => { finished = true; return result })
    await new Promise((resolve) => setTimeout(resolve, 10)); expect(finished).toBe(false)
    stream.decide('card-1', { kind: 'allow' }); expect((await pending).allowed).toBe(true)
  })

  it('deny/alternative injects forward constraint without rewriting history', async () => {
    const stream = new DecisionStream(); stream.confirmSpec(spec); const pending = stream.execute(action())
    stream.decide('card-1', { kind: 'alternative', text: '后续必须使用 Postgres，不允许 SQLite' }); const result = await pending
    expect(result.allowed).toBe(false); expect(stream.cards[0]!.action.args.path).toBe('db.sqlite')
    expect(stream.spec!.constraints).toContain('后续必须使用 Postgres，不允许 SQLite'); expect(stream.events.at(-1)!.message).toContain('后续')
    const next = stream.execute(action({ id: 'card-2' })); await new Promise((resolve) => setTimeout(resolve, 0))
    expect(stream.cards[1]!.verdict.kind).toBe('red'); stream.decide('card-2', { kind: 'cancel' }); await next
  })

  it('supports free rewrite', async () => {
    const stream = new DecisionStream(); stream.confirmSpec(spec); const pending = stream.execute(action())
    stream.decide('card-1', { kind: 'rewrite', text: '后续数据库方案由人明确指定为 Postgres' })
    const result = await pending
    expect(result.allowed).toBe(false); expect(result.reason).toContain('Postgres')
    expect(stream.cards[0]!.state).toBe('overridden')
  })

  it('cancel resolves a pending gate via AbortSignal', async () => {
    const stream = new DecisionStream(); stream.confirmSpec(spec); const pending = stream.execute(action())
    stream.cancel(); expect((await pending).reason).toContain('叫停'); expect(stream.cards[0]!.state).toBe('cancelled')
  })

  it('records blue silently and only turns green after verification', async () => {
    const stream = new DecisionStream(); stream.confirmSpec(spec)
    const result = await stream.execute(action({ description: '选择缓存方案', args: { provider: 'memory' } }))
    expect(result.card.verdict.kind).toBe('blue'); expect(result.card.state).toBe('allowed')
    stream.verify(result.card.id, false); expect(result.card.state).toBe('allowed'); stream.verify(result.card.id, true)
    expect(result.card.state).toBe('allowed'); expect(stream.events.map((e) => e.type)).toContain('card-created')
  })

  it('allows specified and pure execution as gray, with immutable timeline snapshots', async () => {
    const stream = new DecisionStream(); stream.confirmSpec(spec)
    const result = await stream.execute(action({ kind: 'read', description: '读取配置', specified: true }))
    expect(result.card.verdict.kind).toBe('gray'); const before = stream.events; stream.verify(result.card.id, true)
    expect(before).not.toBe(stream.events); expect(before.at(-1)!.message).not.toContain('green')
  })

  it('requires explicit mode selection and rewinds only at completed turn boundaries', async () => {
    const stream = new DecisionStream({ mode: 'rewind-and-fork' }); stream.confirmSpec(spec)
    const first = stream.execute(action({ id: 'turn-1' })); stream.decide('turn-1', { kind: 'alternative', text: '后续使用 Postgres' })
    const result = await first
    expect(result.allowed).toBe(false); expect(result.branchId).toBe('branch-1')
    expect(stream.branchList.map((branch) => branch.id)).toEqual(['main', 'branch-1'])
    expect(stream.events.filter((event) => event.type === 'fork')).toHaveLength(1)
    expect(() => new DecisionStream().rewindAndFork(0, 'x')).toThrow(/not enabled/)
    expect(() => stream.rewindAndFork(1, 'x')).not.toThrow()
  })

  it('keeps multiple agents in one append-only global timeline', async () => {
    const stream = new DecisionStream(); stream.confirmSpec(spec)
    await stream.execute(action({ id: 'a', agentId: 'agent-a', description: '读取配置', kind: 'read', args: { path: 'config.json' } }))
    await stream.execute(action({ id: 'b', agentId: 'agent-b', description: '读取说明', kind: 'read', args: { path: 'README.md' } }))
    expect(new Set(stream.events.map((event) => event.agentId).filter(Boolean))).toEqual(new Set(['agent-a', 'agent-b']))
    expect(stream.events.map((event) => Number(event.id.split('-')[1]))).toEqual(stream.events.map((_, index) => index + 1))
  })

  it('distinguishes runtime failures and only greenlights real evidence', async () => {
    const stream = new DecisionStream({ executor: { execute: async ({ cardId, executionId }) => ({ ok: true, verification: { kind: 'test', detail: 'executor test passed', passed: true }, cardId, executionId }) } }); stream.confirmSpec(spec)
    const result = await stream.execute(action({ description: '选择缓存方案', args: { provider: 'memory' } }))
    expect(result.card.state).toBe('verified'); expect(result.card.verification?.kind).toBe('test')
    const next = await stream.execute(action({ id: 'failed', description: '选择队列方案', args: { provider: 'memory' } }))
    stream.fail(next.card.id, 'runtime-error', '命令退出码 1')
    expect(next.card.failureKind).toBe('runtime-error'); expect(next.card.state).toBe('failed')
    expect(stream.report().summary).toContain('验证通过 1')
  })

  it('records human commands, adjudication and external side-effect limits', async () => {
    const stream = new DecisionStream({ mode: 'rewind-and-fork' }); stream.confirmSpec(spec)
    const pending = stream.execute(action({ id: 'side-effect', kind: 'command', description: '选择 SQLite 并发送邮件通知', args: { external: true } }))
    stream.decide('side-effect', { kind: 'rewrite', text: '后续先不发送邮件' }); await pending
    expect(stream.events.find((event) => event.type === 'fork')?.metadata?.externalSideEffects).toBe('not-reversible')
    expect(stream.events.some((event) => event.type === 'human-adjudication')).toBe(true)
  })

  it('fails closed on approval timeout and never executes the red action', async () => {
    let executions = 0
    const stream = new DecisionStream({ approvalTimeoutMs: 1, executor: { execute: async () => { executions++; return { ok: true } } } }); stream.confirmSpec(spec)
    const result = await stream.execute(action({ id: 'timeout' }))
    expect(result.allowed).toBe(false); expect(result.reason).toContain('超时'); expect(result.card.state).toBe('cancelled'); expect(executions).toBe(0)
  })

  it('keeps source metadata and a globally append-only sequence with concurrent agents', async () => {
    const identities: string[] = []
    const stream = new DecisionStream({ executor: { execute: async ({ agentId, turn, step }) => {
      identities.push(`${agentId}:${turn}:${step}`)
      await new Promise((resolve) => setTimeout(resolve, 1))
      return { ok: true }
    } } })
    stream.confirmSpec(spec)
    await Promise.all(['a', 'b', 'c'].map((agentId) => stream.execute(action({ agentId, kind: 'read', description: `读取 ${agentId}`, args: { path: 'README.md' } }))))
    expect(new Set(identities.map((value) => value.split(':')[0]))).toEqual(new Set(['a', 'b', 'c']))
    expect(stream.events.map((event) => event.sequence)).toEqual(stream.events.map((_, index) => index + 1))
    expect(stream.events.every((event) => event.source)).toBe(true)
  })

  it('makes repeated verdicts idempotent and conflicting verdicts explicit', async () => {
    const stream = new DecisionStream(); stream.confirmSpec(spec); const pending = stream.execute(action({ id: 'idem' }))
    stream.decide('idem', { kind: 'cancel' }); stream.decide('idem', { kind: 'cancel' }); await pending
    expect(() => stream.decide('idem', { kind: 'allow' })).toThrow(/conflicting verdict/)
  })

  it('retries runtime failures three times and escalates separately from drift', async () => {
    let attempts = 0
    const stream = new DecisionStream({ executor: { execute: async () => { attempts++; return { ok: false, error: 'process exit 1' } } } }); stream.confirmSpec(spec)
    const result = await stream.execute(action({ id: 'retry', description: '选择缓存', args: { provider: 'memory' } }))
    expect(attempts).toBe(3); expect(result.card.runtimeAttempts).toBe(3); expect(result.card.failureKind).toBe('runtime-error'); expect(result.card.state).toBe('failed'); expect(stream.report().blockedHelp).toBe(1)
  })

  it('converges when an executor rejects instead of returning a failure result', async () => {
    const stream = new DecisionStream({ executor: { execute: async () => { throw new Error('executor crashed') } } }); stream.confirmSpec(spec)
    const result = await stream.execute(action({ id: 'rejected-executor', description: '选择缓存', args: { provider: 'memory' } }))
    expect(result.card.state).toBe('failed'); expect(result.card.runtimeAttempts).toBe(3); expect(result.reason).toContain('运行失败')
    expect(stream.events.filter((event) => event.type === 'turn-end' && event.cardId === 'rejected-executor')).toHaveLength(1)
  })

  it('requires an executor-bound evidence object for green and reports the event trail', async () => {
    const stream = new DecisionStream(); stream.confirmSpec(spec)
    const result = await stream.execute(action({ id: 'evidence', description: '选择缓存', args: { provider: 'memory' } }))
    stream.verify(result.card.id, true, { kind: 'test', detail: 'human says passed', passed: true })
    expect(result.card.state).toBe('allowed'); expect(stream.report().verified).toBe(0); expect(stream.report().events.some((event) => event.type === 'tool-result' && event.source === 'executor')).toBe(true)
  })

  it('rejects workspace symlinks that escape the executor root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'decision-workspace-')); const outside = mkdtempSync(join(tmpdir(), 'decision-outside-'))
    symlinkSync(outside, join(root, 'linked'))
    const stream = new DecisionStream({ executor: new (await import('./stream.js')).LocalAgentExecutor(root) }); stream.confirmSpec(spec)
    const result = await stream.execute(action({ id: 'symlink', description: '写入链接路径', args: { path: 'linked/escape.txt' } }))
    expect(result.card.state).toBe('failed'); expect(result.toolResult?.error).toContain('outside workspace')
  })

  it('exposes a redo entry on the child branch without deleting the parent history', async () => {
    const stream = new DecisionStream({ mode: 'rewind-and-fork' }); stream.confirmSpec(spec)
    const pending = stream.execute(action({ id: 'fork-me' })); stream.decide('fork-me', { kind: 'rewrite', text: '后续采用 Postgres' }); const forked = await pending
    const redone = await stream.redo('fork-me', action({ description: '选择 Postgres 存储', args: { path: 'db.sql' } }))
    expect(forked.branchId).toBe('branch-1'); expect(redone.card.branchId).toBe('branch-1'); expect(stream.cards.some((card) => card.id === 'fork-me')).toBe(true); expect(stream.branchList).toHaveLength(2)
  })
})
