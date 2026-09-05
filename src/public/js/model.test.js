import { describe, expect, it } from 'vitest'
import { cardTone, pendingCards, humanContextOf } from './model.js'

describe('public model helpers', () => {
  it('classifies pending and verified cards without trusting unsafe content', () => {
    const cards = [{ id: 'red', state: 'pending', verdict: { kind: 'red' } }, { id: 'green', state: 'verified', verdict: { kind: 'red' } }]
    expect(cardTone(cards[0])).toBe('red')
    expect(cardTone(cards[1])).toBe('green')
    expect(pendingCards({ cards })).toEqual([cards[0]])
  })

  it('falls back to the session spec for card human context', () => {
    expect(humanContextOf({}, { spec: { request: '做事', constraints: ['不能越界'] } })).toEqual({ request: '做事', constraints: ['不能越界'], lastAdjudication: undefined })
  })
})
