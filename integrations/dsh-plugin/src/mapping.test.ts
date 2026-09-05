import { describe, expect, it } from 'vitest'
import {
  ASK_USER_DENY_REASON,
  ASK_USER_TOOL,
  decisionFromCard,
  injectedConstraintMessage,
  isHumanStop,
  toWorkUnit,
  type TimelineEventLike,
} from './mapping.js'

describe('dsh mapping', () => {
  it('aggregates the first tool call into one work unit', () => {
    const unit = toWorkUnit({
      agentId: 'a', turn: 2, step: 3, declarations: [], planned: ['write'],
      firstCall: { callId: 'c1', name: 'write', arguments: { path: 'x' } },
    })
    expect(unit.id).toBe('dsh-unit-a-t2-s3')
    expect(unit.toolCalls).toHaveLength(1)
    expect(unit.toolCalls[0]?.args.arguments).toEqual({ path: 'x' })
  })

  it('fails closed for unknown and cancelled cards', () => {
    expect(decisionFromCard({ id: 'x', state: 'unknown' as never })).toEqual({ kind: 'deny', reason: expect.stringContaining('未知') })
    expect(decisionFromCard({ id: 'x', state: 'cancelled' })).toEqual({ kind: 'deny', reason: expect.stringContaining('人工') })
  })

  it('recognises only human cancellation and preserves unknown events', () => {
    const human: TimelineEventLike = { id: '1', sequence: 1, type: 'cancel', message: '已被人工叫停', metadata: { byHuman: true } }
    const timeout: TimelineEventLike = { ...human, id: '2', metadata: { failClosed: true }, message: '审批超时，已 fail-closed' }
    const unknown: TimelineEventLike = { ...human, id: '3', type: 'future-event' }
    expect(isHumanStop(human)).toBe(true)
    expect(isHumanStop(timeout)).toBe(false)
    expect(isHumanStop(unknown)).toBe(false)
  })

  it('keeps the ask-user denial and forward-only injection explicit', () => {
    expect(ASK_USER_TOOL).toBe('ask_user_question')
    expect(ASK_USER_DENY_REASON).toContain('决策流卡片')
    expect(injectedConstraintMessage('改用 postgres', 'card-1')).toContain('card-1')
  })
})
