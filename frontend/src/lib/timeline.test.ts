import { expect, it } from 'vitest'
import type { AppEvent, RunState } from '../../../decision-desk/shared/types.js'
import { timelineEntries } from './timeline.js'

const run = { steps: [], workerLabel: 'DeepSeek V4 Pro' } as unknown as RunState
const event = (seq: number, type: string, data: unknown = {}): AppEvent => ({
  id: String(seq),
  seq,
  type,
  data,
  runId: 'test',
  at: '2026-09-05T10:00:00.000Z',
})

it('excludes internal repair notes while preserving real failures and the corrected control action', () => {
  const source = [
    event(3, 'run.control-reclassified', {
      reason: '仅工程沟通',
      previousIntervention: { id: 'wrongly-added' },
    }),
    event(2, 'run.error', { message: 'The operation was aborted due to timeout' }),
    event(1, 'human.intervention', {
      intervention: { id: 'wrongly-added', action: 'followup', text: '继续实现' },
    }),
  ]
  const entries = timelineEntries(source, run)
  expect(entries.map((entry) => entry.event.seq)).toEqual([1, 2])
  expect(entries[0].title).toBe('继续任务')
  expect(entries[0].category).toBe('运行进展')
  expect(entries[1].tone).toBe('error')
  expect(entries[1].summary).toBe('该次模型请求超时。')
  expect(source.map((entry) => entry.seq)).toEqual([3, 2, 1])
  expect(JSON.stringify(entries)).not.toContain('仅工程沟通')
})

it('does not present execution, approval or empty checks as successful verification', () => {
  const entries = timelineEntries(
    [
      event(1, 'tool.finished', { status: 'done' }),
      event(2, 'human.intervention', { intervention: { action: 'acknowledge' } }),
      event(3, 'verification.completed', { results: [] }),
      event(4, 'verification.completed', {
        results: [
          { name: '检查 A', passed: true },
          { name: '检查 B', passed: false },
        ],
      }),
      event(5, 'verification.completed', { results: [{ name: '检查 A', passed: true }] }),
    ],
    run,
  )
  expect(entries.map((entry) => entry.tone)).toEqual([
    'neutral',
    'human',
    'neutral',
    'error',
    'verified',
  ])
  expect(entries[3].summary).toBe('1 / 2 项检查通过')
})

it('keeps resume controls separate from human judgments and preserves full task requirements', () => {
  const requirements = ['保持离线', '周视图', '允许编辑课程']
  const entries = timelineEntries(
    [
      event(1, 'constraints.confirmed', { constraints: requirements.map((text) => ({ text })) }),
      event(2, 'run.resume-requested', { revision: 2 }),
    ],
    run,
  )
  expect(entries[0].requirements).toEqual(requirements)
  expect(entries[0].category).toBe('你的操作')
  expect(entries[1].category).toBe('运行进展')
  expect(entries[1].fields).toEqual([{ label: '要求版本', value: 'v2' }])
})
