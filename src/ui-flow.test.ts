import { describe, expect, it } from 'vitest'
import { demoPlan, groupTimelineByStep } from './ui-flow.js'

describe('demo UI flow', () => {
  it('keeps both correction modes explicit in the complete sequence', () => {
    expect(demoPlan('forward-only').map((item) => item.stage)).toEqual(['blue', 'red', 'correction', 'tool', 'evidence', 'runtime-failure', 'complete'])
    expect(demoPlan('rewind-and-fork')[2]?.action).toContain('fork')
  })

  it('projects coarse turn and step groups without unsafe markup', () => {
    expect(groupTimelineByStep([{ turn: 1, step: 1 }, { turn: 1, step: 1 }, { turn: 2, step: 2 }])).toEqual(['1:1', '2:2'])
  })
})
