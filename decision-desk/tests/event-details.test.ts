import { expect, it } from 'vitest'
import { eventDetails } from '../server/event-details.js'
import { fixture } from './helpers.js'

it('links short events to complete tool arguments, results and model usage across restarted sessions', async () => {
  const f = fixture()
  try {
    const state = f.manager.create('查看页面内容', 'demo')
    const store = f.manager.store
    const request = store.append(state, 'model.request', { number: 1 })
    const at = Date.parse(request.at)
    store.recordRaw(state.id, {
      type: 'assistant/message',
      seq: 7,
      time: at - 1000,
      data: {
        message: { content: [{ type: 'text', text: 'old response' }] },
        usage: { outputTokens: 999 },
      },
    })
    store.recordRaw(state.id, {
      type: 'assistant/message',
      seq: 7,
      time: at,
      data: {
        message: {
          source: { model: 'test' },
          content: [
            { type: 'reasoning', text: '检查' },
            { type: 'text', text: '已检查文件' },
          ],
        },
        usage: { inputTokens: 12, outputTokens: 34 },
      },
    })
    state.steps.push({
      id: 'step-1',
      callId: 'call-1',
      tool: 'read_file',
      args: { path: 'index.html' },
      revision: 1,
      createdAt: request.at,
      status: 'done',
      result: '完整正文'.repeat(500),
    })
    const event = store.append(state, 'tool.finished', { stepId: 'step-1', status: 'done' })
    const detail = eventDetails(store, state, event.seq)!
    expect(detail.action?.result).toBe('完整正文'.repeat(500))
    if (!('modelResponse' in detail)) throw new Error('缺少关联模型响应')
    expect(detail.modelResponse?.usage.outputTokens).toBe(34)
    expect(detail.modelResponse?.reasoningCharacters).toBe(2)
    expect(detail.modelResponse?.content).toEqual([{ type: 'text', text: '已检查文件' }])
    const internal = store.append(state, 'run.control-reclassified', { reason: '内部修复' })
    expect(eventDetails(store, state, internal.seq)).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})
