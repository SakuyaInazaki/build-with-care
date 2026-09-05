import { describe, expect, it, vi } from 'vitest'
import { WorkbenchClient, WorkbenchError } from './workbench-client.js'

describe('workbench client', () => {
  it('does not turn a missing /units route into a successful fallback', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 }))
    const client = new WorkbenchClient('http://workbench', { fetch: fetcher })
    await expect(client.postUnit('s', { goal: 'g', decisions: [], toolCalls: [] })).rejects.toEqual(expect.any(WorkbenchError))
    expect(fetcher).toHaveBeenCalledWith('http://workbench/api/sessions/s/units', expect.objectContaining({ method: 'POST' }))
  })

  it('posts final tool results through the adapter event route', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 }))
    const client = new WorkbenchClient('http://workbench', { fetch: fetcher })
    await expect(client.postToolResult('s', { unitId: 'u', callId: 'c', tool: 'bash', ok: false, error: 'boom' })).resolves.toBe(true)
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ type: 'tool-result', version: '0.1.3-alpha.1', payload: { ok: false, error: 'boom' } })
  })
})
