import { afterEach, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createApp, errorHandler } from '../server/app.js'
import { demoHtml } from '../server/demo.js'
import { completionUrl } from '../server/models.js'
import { DEMO_PROMPT } from '../shared/types.js'
import { fixture, until } from './helpers.js'

const fixtures: ReturnType<typeof fixture>[] = [],
  servers: Server[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup()
  for (const s of servers.splice(0))
    await new Promise<void>((resolve) => {
      s.closeAllConnections()
      s.close(() => resolve())
    })
})
function setup() {
  const f = fixture()
  fixtures.push(f)
  return f
}
async function listen(server: Server) {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

it('uses the actual compatible worker and independent reviewer adapters with a local mock upstream', async () => {
  const requests: { url: string; auth?: string; body: any }[] = []
  let workerStage = 0
  const baseUrl = await listen(
    createServer(async (req, res) => {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      requests.push({ url: req.url!, auth: req.headers.authorization, body })
      let message: any
      if (req.url === '/reviewer/chat/completions') {
        const input = JSON.parse(body.messages[1].content),
          conflict = input.arguments.content.includes('localStorage')
        message = {
          content: JSON.stringify({
            classification: conflict ? 'conflict' : 'execution',
            title: conflict ? '刷新后仍保留数据' : '更新内存表单',
            summary: '根据拟写入代码进行审查',
            impact: '',
            constraintIds: conflict
              ? [input.constraints.find((c: any) => c.text.includes('刷新')).id]
              : [],
            evidence: conflict ? 'localStorage.setItem' : '',
            options: [],
            topic: 'storage',
          }),
        }
      } else {
        const stage = workerStage++
        if (
          stage > 0 &&
          body.messages.some(
            (message: any) =>
              message.role === 'assistant' && typeof message.reasoning_content !== 'string',
          )
        ) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'reasoning_content is required for assistant history' }))
          return
        }
        const args =
          stage === 0
            ? { path: 'index.html', content: demoHtml('local'), intent: '持久化保存' }
            : stage === 1
              ? { path: 'index.html', content: demoHtml('memory'), intent: '改为内存' }
              : { path: 'index.html' }
        message =
          stage < 3
            ? {
                content: null,
                tool_calls: [
                  {
                    id: `call-${stage}`,
                    type: 'function',
                    function: {
                      name: stage === 2 ? 'verify_app' : 'write_file',
                      arguments: JSON.stringify(args),
                    },
                  },
                ],
              }
            : { content: '已修改并完成列出的静态检查。' }
        message.reasoning_content = `Test planning state ${stage}`
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 5 },
        }),
      )
    }),
  )
  const { manager } = setup()
  manager.updateSettings({
    worker: {
      baseUrl: `${baseUrl}/worker`,
      model: 'worker-test',
      family: 'family-a',
      apiKey: 'worker-test-secret',
    },
    reviewer: {
      baseUrl: `${baseUrl}/reviewer`,
      model: 'judge-test',
      family: 'family-b',
      apiKey: 'reviewer-test-secret',
    },
    reviewTimeoutMs: 2000,
  })
  const state = manager.create(DEMO_PROMPT, 'live')
  await manager.start(
    state.id,
    state.constraints.map((c) => c.text),
  )
  await until(() => state.status === 'waiting' || state.status === 'error')
  expect(state.error).toBeUndefined()
  expect(state.files).toHaveLength(0)
  expect(state.decisions[0].review.source).toBe('independent-model')
  const runtime = manager.runtime(state.id),
    gate = state.gates[0]
  runtime.verdict({
    requestId: randomUUID(),
    revision: state.revision,
    decisionId: gate.decisionId,
    gateId: gate.id,
    action: 'correct',
    text: '只使用页面内存，刷新后清空报名信息',
  })
  await until(() => ['completed', 'error'].includes(state.status))
  expect(state.error).toBeUndefined()
  expect(runtime.workspace.read('index.html')).not.toContain('localStorage')
  expect(state.interventions[0].progress).toBe('verified')
  const workers = requests.filter((r) => r.url.startsWith('/worker')),
    reviewers = requests.filter((r) => r.url.startsWith('/reviewer'))
  expect(workers).toHaveLength(4)
  expect(reviewers).toHaveLength(2)
  expect(workers.every((r) => r.auth === 'Bearer worker-test-secret')).toBe(true)
  expect(reviewers.every((r) => r.auth === 'Bearer reviewer-test-secret' && !r.body.tools)).toBe(
    true,
  )
  expect(
    workers[1].body.messages.some((m: any) => m.role === 'tool' && m.tool_call_id === 'call-0'),
  ).toBe(true)
  expect(JSON.stringify(workers[1].body.messages)).toContain('DECISION_DESK_INTERVENTION:')
  expect(workers[0].body.parallel_tool_calls).toBe(false)
  expect(
    workers[3].body.messages
      .filter((message: any) => message.role === 'assistant')
      .map((message: any) => message.reasoning_content),
  ).toEqual(['Test planning state 0', 'Test planning state 1', 'Test planning state 2'])
  for (const file of ['state.json', 'events.jsonl', 'dsh-events.jsonl'])
    expect(readFileSync(path.join(manager.store.directory(state.id), file), 'utf8')).not.toContain(
      '-test-secret',
    )
})

it('requires a local browser session and never returns configured secrets', async () => {
  const { manager } = setup(),
    app = createApp(manager)
  app.use(errorHandler)
  const baseUrl = await listen(createServer(app))
  expect((await fetch(`${baseUrl}/api/settings`)).status).toBe(401)
  expect(
    (await fetch(`${baseUrl}/api/bootstrap`, { headers: { origin: 'https://example.com' } }))
      .status,
  ).toBe(403)
  const bootstrap = await fetch(`${baseUrl}/api/bootstrap`),
    cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]
  expect(bootstrap.headers.get('set-cookie')).toContain('HttpOnly')
  const config = {
    worker: {
      baseUrl: 'https://example.com/v1',
      model: 'a',
      family: 'a',
      apiKey: 'local-secret-a',
    },
    reviewer: {
      baseUrl: 'https://example.org/v1',
      model: 'b',
      family: 'b',
      apiKey: 'local-secret-b',
    },
    reviewTimeoutMs: 2000,
  }
  const updated = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  expect(updated.status).toBe(200)
  const publicData = await updated.json()
  expect(publicData.configured).toBe(true)
  expect(publicData.worker.hasKey).toBe(true)
  expect(JSON.stringify(publicData)).not.toContain('local-secret')
  expect(JSON.stringify(publicData)).not.toContain('apiKey')
  const invalid = await fetch(`${baseUrl}/api/runs`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'x', mode: 'live' }),
  })
  expect(invalid.status).toBe(400)
})

it('retains credentials only for the same endpoint and validates compatible URLs', () => {
  const { manager } = setup()
  const initial = {
    worker: { baseUrl: 'https://example.com/v1', model: 'a', family: 'a', apiKey: 'secret-a' },
    reviewer: { baseUrl: 'https://example.org/v1', model: 'b', family: 'b', apiKey: 'secret-b' },
    reviewTimeoutMs: 2000,
  }
  manager.updateSettings(structuredClone(initial))
  manager.updateSettings({ ...structuredClone(initial), worker: { ...initial.worker, apiKey: '' } })
  expect(manager.settings.worker.apiKey).toBe('secret-a')
  manager.updateSettings({
    ...structuredClone(initial),
    worker: { ...initial.worker, baseUrl: 'https://another.example/v1', apiKey: '' },
  })
  expect(manager.settings.worker.apiKey).toBe('')
  expect(completionUrl('https://example.com/v1/chat/completions/')).toBe(
    'https://example.com/v1/chat/completions',
  )
  expect(() => completionUrl('http://remote.example/v1')).toThrow()
  expect(() => completionUrl('https://key:secret@example.com')).toThrow()
})
