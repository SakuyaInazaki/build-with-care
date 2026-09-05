import { afterEach, expect, it, vi } from 'vitest'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { streamCompletion } from '../server/models.js'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

const servers: Server[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
async function mock(handler: (response: ServerResponse, body: any) => void) {
  const server = createServer(async (request, response) => {
    let text = ''
    for await (const part of request) text += part
    response.setHeader('Content-Type', 'text/event-stream')
    handler(response, JSON.parse(text))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    model: 'test',
    family: 'test',
    apiKey: '',
  }
}
const frame = (delta: any, finish_reason: string | null = null, usage?: any) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }], usage })}\r\n\r\n`

it('delivers real reasoning before the response finishes, assembles split UTF-8 tool arguments and usage', async () => {
  let finish!: () => void
  const config = await mock((response, body) => {
    expect(body.stream).toBe(true)
    expect(body).not.toHaveProperty('max_tokens')
    response.write(': keepalive\r\n\r\n')
    response.write(frame({ reasoning_content: '正在检查' }))
    finish = () => {
      const rest = Buffer.from(
        frame({ content: '开始写入' }) +
          frame({
            tool_calls: [
              {
                index: 0,
                id: 'call-1',
                function: { name: 'write_file', arguments: '{"content":"' },
              },
            ],
          }) +
          frame({ tool_calls: [{ index: 0, function: { arguments: '你好"}' } }] }) +
          frame({}, 'tool_calls', { prompt_tokens: 12, completion_tokens: 34 }) +
          'data: [DONE]\r\n\r\n',
      )
      // Split inside a multi-byte character and inside SSE separators.
      for (let i = 0; i < rest.length; i += 7) response.write(rest.subarray(i, i + 7))
      response.end()
    }
  })
  const timer = vi.spyOn(AbortSignal, 'timeout')
  const stream = streamCompletion(config, [{ role: 'user', content: 'test' }])[
    Symbol.asyncIterator
  ]()
  expect((await stream.next()).value).toMatchObject({ type: 'block-start', blockType: 'reasoning' })
  expect((await stream.next()).value).toMatchObject({ type: 'reasoning-delta', text: '正在检查' })
  finish()
  const chunks: StreamChunk[] = []
  for (;;) {
    const next = await stream.next()
    if (next.done) break
    chunks.push(next.value)
  }
  expect(chunks).toContainEqual({
    type: 'block-end',
    index: 2,
    block: { type: 'tool-call', id: 'call-1', name: 'write_file', arguments: '{"content":"你好"}' },
  })
  expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 12, outputTokens: 34 } })
  expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  expect(timer).not.toHaveBeenCalled()
})

it('rejects a disconnected or truncated stream without emitting a successful finish', async () => {
  for (const reason of [null, 'length']) {
    const config = await mock((response) =>
      response.end(
        frame(
          {
            tool_calls: [
              {
                index: 0,
                id: 'call-1',
                function: { name: 'write_file', arguments: '{"content":' },
              },
            ],
          },
          reason,
        ),
      ),
    )
    const chunks: StreamChunk[] = []
    await expect(
      (async () => {
        for await (const chunk of streamCompletion(config, [{ role: 'user', content: 'test' }]))
          chunks.push(chunk)
      })(),
    ).rejects.toThrow(/中断|未完整/)
    expect(chunks.some((chunk) => chunk.type === 'finish' || chunk.type === 'block-end')).toBe(
      false,
    )
  }
})

it('cancels immediately while the upstream stream remains open', async () => {
  const config = await mock((response) => response.write(frame({ reasoning_content: '思考中' })))
  const controller = new AbortController()
  const stream = streamCompletion(
    config,
    [{ role: 'user', content: 'test' }],
    undefined,
    controller.signal,
  )[Symbol.asyncIterator]()
  await stream.next()
  await stream.next()
  const waiting = stream.next()
  const cancelled = new Error('用户停止任务')
  controller.abort(cancelled)
  await expect(waiting).rejects.toBe(cancelled)
})
