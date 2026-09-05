import { expect, it } from 'vitest'
import type { RunState } from '../../../decision-desk/shared/types.js'
import { attentionItems } from './attention.js'

const run = { id: 'run', title: '测试任务', status: 'running', revision: 1, gates: [], steps: [] } as unknown as RunState
it('alerts only when input is required, not for ongoing review or verification', () => {
  expect(attentionItems([run])).toEqual([])
  expect(attentionItems([{ ...run, status: 'completed' }])).toEqual([])
  expect(attentionItems([{ ...run, status: 'stopped' }])).toEqual([])
  expect(attentionItems([{ ...run, status: 'error' }])[0].message).toContain('需要你处理')
  expect(attentionItems([{ ...run, reviewFailure: { stepId: 'step', message: 'private diagnostic' } }])[0].message).toBe('审查未完成，需要重试。')
})
it('uses stable gate identities across repeated state events and includes pending intake', () => {
  const waiting = { ...run, status: 'waiting', gates: [{ id: 'gate', status: 'pending' }] } as RunState
  expect(attentionItems([waiting])[0].key).toBe(attentionItems([{ ...waiting, lastEventSeq: 99 }])[0].key)
  expect(attentionItems([{ ...waiting, gates: [{ ...waiting.gates[0], status: 'allowed' }] }])).toEqual([])
  const ready = { ...run, status: 'ready', grill: { status: 'question', round: 2 } } as RunState
  expect(attentionItems([ready])[0].message).toContain('回答')
  expect(attentionItems([{ ...ready, grill: { ...ready.grill!, status: 'confirm' } }])[0].message).toContain('确认')
})
