import { describe, expect, it, vi } from 'vitest'
import { DecisionStreamBridge, resolveConfig } from './index.js'
import { ASK_USER_DENY_REASON, ASK_USER_TOOL } from './mapping.js'

describe('plugin config', () => {
  it('resolves the locked target without an ask-user escape hatch', () => {
    const config = resolveConfig({}, { DECISION_STREAM_URL: 'http://workbench', DECISION_STREAM_BLOCK_ASK_USER: '0' })
    expect(config.baseUrl).toBe('http://workbench')
    expect('blockAskUser' in config).toBe(false)
  })

  it('denies ask_user before the next listener and observes post-execute', async () => {
    const bridge = new DecisionStreamBridge({} as never, { log: () => undefined })
    const internal = bridge as unknown as {
      preExecute: (exec: unknown, next: () => Promise<unknown>) => Promise<{ kind: string; reason?: string }>
      postExecute: (exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<unknown>
    }
    const denied = await internal.preExecute({ name: ASK_USER_TOOL, callId: 'ask-1' }, async () => ({ kind: 'allow' }))
    expect(denied).toEqual({ kind: 'deny', reason: ASK_USER_DENY_REASON })
    const next = vi.fn(async () => ({ kind: 'accept' }))
    await internal.postExecute({ name: 'write', callId: 'write-1' }, { isError: false }, next)
    expect(next).toHaveBeenCalledOnce()
  })

  it('injects a forward-only constraint through the agent API', () => {
    const bridge = new DecisionStreamBridge({} as never, { log: () => undefined })
    const inject = vi.fn()
    bridge.injectConstraint({ id: 'agent-1', inject } as never, 'use postgres', 'unit-1')
    expect(inject).toHaveBeenCalledOnce()
    expect(inject.mock.calls[0]?.[0].content[0].text).toContain('use postgres')
  })
})
