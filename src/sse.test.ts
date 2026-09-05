import { describe, expect, it } from 'vitest'
import { parseSseFrames } from './sse.js'

describe('SSE framing', () => {
  it('parses event and multi-line data without depending on a network client', () => {
    expect(parseSseFrames(': connected\n\nevent: state\ndata: {"ok":true}\n\n')).toEqual([{ event: 'state', data: '{"ok":true}' }])
  })
})
