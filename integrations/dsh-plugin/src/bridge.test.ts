import { describe, expect, it, vi } from 'vitest'
import { DecisionStreamBridge } from './index.js'

const allowedState = (cardId: string) => ({
  sessionId: 'workbench', mode: 'forward-only' as const, spec: { confirmed: true },
  cards: [{ id: cardId, state: 'allowed' as const }], timeline: [],
})

describe('0.1.3 bridge behavior', () => {
  it('aggregates a step into one unit, gates later sub-calls, and records final results', async () => {
    const bridge = new DecisionStreamBridge({} as never, {
      sessionId: 'workbench', eventsDir: '', pollIntervalMs: 1, log: () => undefined,
    })
    const client = bridge.client
    vi.spyOn(client, 'getState').mockResolvedValue(allowedState('unused') as never)
    const postUnit = vi.spyOn(client, 'postUnit').mockImplementation(async (_session, unit) => allowedState(unit.id!) as never)
    const postAction = vi.spyOn(client, 'postAction').mockImplementation(async (_session, action) => allowedState(action.id!) as never)
    const postResult = vi.spyOn(client, 'postToolResult').mockResolvedValue(true)
    const internal = bridge as unknown as {
      onSessionEvent: (session: { id: string }, event: unknown) => void
      onToolResult: (exec: unknown, result: unknown) => void
    }
    internal.onSessionEvent({ id: 'agent-1' }, { type: 'step/start', seq: 0, time: 1, data: { turn: 4, step: 2 } })
    internal.onSessionEvent({ id: 'agent-1' }, {
      type: 'assistant/message', seq: 1, time: 2,
      data: { turn: 4, step: 2, message: { content: [{ type: 'text', text: 'Implement storage' }, { type: 'tool-call', name: 'write' }, { type: 'tool-call', name: 'bash' }] } },
    })
    const agent = { id: 'agent-1' }
    const first = { callId: 'c1', name: 'write', arguments: { path: 'x' }, agent, signal: new AbortController().signal }
    const second = { callId: 'c2', name: 'bash', arguments: { command: 'npm test' }, agent, signal: new AbortController().signal }

    await expect(bridge.gate(first as never)).resolves.toEqual({ kind: 'allow' })
    await expect(bridge.gate(second as never)).resolves.toEqual({ kind: 'allow' })
    expect(postUnit).toHaveBeenCalledOnce()
    expect(postUnit.mock.calls[0]?.[1]).toMatchObject({
      id: 'dsh-unit-agent-1-t4-s2', goal: 'Implement storage',
      summary: 'dsh step 计划调用：write, bash', toolCalls: [{ tool: 'write' }],
    })
    expect(postAction.mock.calls[0]?.[1].args.unitId).toBe('dsh-unit-agent-1-t4-s2')

    internal.onToolResult(first, { isError: false, value: { written: true }, content: [], meta: { path: 'x' } })
    await vi.waitFor(() => expect(postResult).toHaveBeenCalledOnce())
    expect(postResult.mock.calls[0]?.[1]).toMatchObject({ unitId: 'dsh-unit-agent-1-t4-s2', callId: 'c1', ok: true, output: { written: true }, evidence: { path: 'x' } })
  })

  it('injects constraints and turns only human timeline cancellation into agent.cancel', async () => {
    const bridge = new DecisionStreamBridge({ agents: { get: () => undefined } } as never, { eventsDir: '', log: () => undefined })
    const inject = vi.fn()
    const cancel = vi.fn()
    const agent = { id: 'agent-1', status: 'running', inject, cancel }
    bridge.agents.set('agent-1', agent as never)
    const internal = bridge as unknown as { resolvedSessionId: string; adapterEventRoute: string; watchTimeline: () => Promise<void> }
    internal.resolvedSessionId = 'workbench'
    internal.adapterEventRoute = 'absent'
    vi.spyOn(bridge.client, 'timeline').mockResolvedValue([
      { id: 'inject-1', sequence: 1, type: 'injection', agentId: 'agent-1', message: 'override', metadata: { constraint: 'use postgres' } },
      { id: 'timeout-1', sequence: 2, type: 'cancel', agentId: 'agent-1', message: '审批超时', metadata: { failClosed: true } },
      { id: 'cancel-1', sequence: 3, type: 'cancel', agentId: 'agent-1', message: '已被人工叫停', metadata: { byHuman: true } },
    ])

    await internal.watchTimeline()
    expect(inject).toHaveBeenCalledOnce()
    expect(inject.mock.calls[0]?.[0].content[0].text).toContain('use postgres')
    expect(cancel).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledWith({ kind: 'user' })
  })
})
