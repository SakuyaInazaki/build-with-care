import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { complete } from '../server/models.js'

afterEach(() => vi.unstubAllGlobals())
const config = { baseUrl: 'https://example.test/v1', model: 'test', family: 'test', apiKey: '' }
const waitForAbort = (_url: unknown, init: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init.signal!
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })

it('reports a readable timeout instead of leaking the fetch abort message', async () => {
  vi.stubGlobal('fetch', waitForAbort)
  await expect(
    complete(config, [{ role: 'user', content: 'test' }], undefined, undefined, 20),
  ).rejects.toThrow('模型响应超过 1 秒，本次请求已停止。')
})

it('keeps an explicit cancellation distinct from a model timeout', async () => {
  vi.stubGlobal('fetch', waitForAbort)
  const controller = new AbortController()
  const cancelled = new Error('用户停止任务')
  const pending = complete(
    config,
    [{ role: 'user', content: 'test' }],
    undefined,
    controller.signal,
    5000,
  )
  controller.abort(cancelled)
  await expect(pending).rejects.toBe(cancelled)
})

it('keeps execution requests alive without a timer and still cancels an in-flight request', async () => {
  let acknowledge: (() => void) | undefined
  const received = new Promise<void>((resolve) => {
    acknowledge = resolve
  })
  const server = createServer((_req, _res) => acknowledge!())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const timer = vi.spyOn(AbortSignal, 'timeout')
  const controller = new AbortController()
  try {
    const port = (server.address() as { port: number }).port
    const pending = complete(
      { ...config, baseUrl: `http://127.0.0.1:${port}` },
      [{ role: 'user', content: 'wait for user cancellation' }],
      undefined,
      controller.signal,
      null,
    )
    await received
    expect(timer).not.toHaveBeenCalled()
    const cancelled = new Error('用户停止任务')
    controller.abort(cancelled)
    await expect(pending).rejects.toBe(cancelled)
  } finally {
    timer.mockRestore()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('sends the selected DeepSeek effort and disables thinking only when selected', async () => {
  const requests: Record<string, any>[] = []
  vi.stubGlobal('fetch', (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)))
    return Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })),
    )
  })
  const model = { ...config, baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro' }
  for (const reasoningEffort of ['low', 'high', 'max', 'none'] as const)
    await complete({ ...model, reasoningEffort }, [{ role: 'user', content: 'test' }])
  expect(requests.slice(0, 3).map((r) => [r.thinking.type, r.reasoning_effort])).toEqual([
    ['enabled', 'low'],
    ['enabled', 'high'],
    ['enabled', 'max'],
  ])
  expect(requests[3].thinking.type).toBe('disabled')
  expect(requests[3]).not.toHaveProperty('reasoning_effort')
  await expect(
    complete({ ...config, reasoningEffort: 'max' }, [{ role: 'user', content: 'test' }]),
  ).rejects.toThrow('未配置推理强度支持')
  expect(requests).toHaveLength(4)
})
