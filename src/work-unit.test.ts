import { describe, expect, it } from 'vitest'
import { extractDecisions, matchDecisions, structureConstraint, verdictForUnit } from './work-unit.js'

describe('work-unit policy model', () => {
  it('matches normalized domain and choice exactly, not substrings', () => {
    const constraints = structureConstraint('存储必须使用 PostgreSQL', { id: 'c1', source: 'spec' })
    expect(matchDecisions([{ domain: 'database', choice: 'pg' }], constraints)[0]!.outcome).toBe('required-match')
    expect(matchDecisions([{ domain: 'cache', choice: 'sqlite' }], constraints)[0]!.outcome).toBe('unconstrained')
  })

  it('never treats an agent specified claim as human evidence', () => {
    const constraints = structureConstraint('不允许 SQLite', { id: 'c1', source: 'spec' })
    const match = matchDecisions([{ domain: 'storage', choice: 'sqlite', specifiedByHuman: true }], constraints, { request: '做数据库' })[0]!
    expect(match.outcome).toBe('forbidden')
  })

  it('extracts choices from an undeclared tool call and keeps a no-decision write blue', () => {
    const action = { tool: 'write_file', kind: 'write' as const, description: '写 sqlite 配置', args: { path: 'db.sqlite' } }
    expect(extractDecisions(action)[0]).toMatchObject({ domain: 'storage', choice: 'sqlite', extracted: true })
    expect(verdictForUnit({ goal: '执行', decisions: [], toolCalls: [action] }, [], [])).toMatchObject({ kind: 'blue' })
  })

  it('supports forward-only constraints', () => {
    const constraint = { id: 'c1', domain: 'storage', kind: 'forbid' as const, values: ['sqlite'], text: '后续不用 SQLite', source: 'adjudication' as const, createdAt: new Date().toISOString(), affectsFromTurn: 2 }
    expect(matchDecisions([{ domain: 'storage', choice: 'sqlite' }], [constraint], { turn: 2 })[0]!.outcome).toBe('unconstrained')
    expect(matchDecisions([{ domain: 'storage', choice: 'sqlite' }], [constraint], { turn: 3 })[0]!.outcome).toBe('forbidden')
  })
})
