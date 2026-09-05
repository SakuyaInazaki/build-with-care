import { describe, expect, it } from 'vitest'
import type { LlmRoleConfig } from './config.js'
import { LlmClient, LlmError, endpointFor, extractJson, fromAnthropicResponse, fromOpenAiResponse, toAnthropicBody, toOpenAiBody, type ChatRequest, type FetchLike } from './client.js'

const config = (overrides: Partial<LlmRoleConfig> = {}): LlmRoleConfig => ({ role: 'judge', provider: 'openai', baseUrl: 'https://gw.example.com/v1', apiKey: 'sk-test', model: 'gpt-test', timeoutMs: 5000, ...overrides })
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const openaiText = (content: string) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }], model: 'gpt-test', usage: { prompt_tokens: 3, completion_tokens: 4 } })

type Captured = { url: string; init: RequestInit; body: Record<string, unknown> }
function capture(responder: (call: Captured, index: number) => Response | Promise<Response>): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = []
  const fetch: FetchLike = async (url, init) => { const call = { url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> }; calls.push(call); return responder(call, calls.length - 1) }
  return { fetch, calls }
}

const conversation: ChatRequest = {
  system: '你是判官',
  messages: [
    { role: 'user', content: '开始' },
    { role: 'assistant', content: '我先看一下', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.txt' } }, { id: 'c2', name: 'read_file', args: { path: 'b.txt' } }] },
    { role: 'tool', toolCallId: 'c1', name: 'read_file', content: 'A' },
    { role: 'tool', toolCallId: 'c2', name: 'read_file', content: 'DENIED: no', isError: true },
    { role: 'user', content: '人刚刚补充了约束' },
  ],
  tools: [{ name: 'read_file', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
  toolChoice: 'auto',
}

describe('endpoint resolution', () => {
  it('normalizes base urls for both protocols', () => {
    expect(endpointFor({ provider: 'openai', baseUrl: 'https://api.deepseek.com/v1/' })).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(endpointFor({ provider: 'openai', baseUrl: 'https://gw/v1/chat/completions' })).toBe('https://gw/v1/chat/completions')
    expect(endpointFor({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com' })).toBe('https://api.anthropic.com/v1/messages')
    expect(endpointFor({ provider: 'anthropic', baseUrl: 'https://gw/anthropic/v1' })).toBe('https://gw/anthropic/v1/messages')
    expect(endpointFor({ provider: 'anthropic', baseUrl: 'https://gw/v1/messages' })).toBe('https://gw/v1/messages')
  })
})

describe('OpenAI-compatible translation', () => {
  it('builds a chat/completions body with tools, tool calls, tool results and json mode', () => {
    const body = toOpenAiBody(config(), { ...conversation, jsonMode: true, maxTokens: 99 })
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[0]).toEqual({ role: 'system', content: '你是判官' })
    expect(messages[2]).toMatchObject({ role: 'assistant', content: '我先看一下' })
    expect((messages[2]!.tool_calls as unknown[])[0]).toEqual({ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } })
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'A' })
    expect(messages[5]).toEqual({ role: 'user', content: '人刚刚补充了约束' })
    expect(body.tools).toEqual([{ type: 'function', function: { name: 'read_file', description: '读文件', parameters: conversation.tools![0]!.parameters } }])
    expect(body).toMatchObject({ model: 'gpt-test', max_tokens: 99, stream: false, tool_choice: 'auto', response_format: { type: 'json_object' } })
    const empty = toOpenAiBody(config(), { messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'x', name: 'f', args: {} }] }] })
    expect((empty.messages as Array<Record<string, unknown>>)[0]!.content).toBeNull()
  })

  it('parses tool calls, text parts and finish reasons', () => {
    const response = fromOpenAiResponse({ model: 'deepseek-chat', usage: { prompt_tokens: 10, completion_tokens: 2 }, choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'decide', arguments: '{"topic":"存储","choice":"Postgres"}' } }, { id: 'call_2', type: 'function', function: { name: 'finish', arguments: '{broken' } }] } }] })
    expect(response.toolCalls).toEqual([{ id: 'call_1', name: 'decide', args: { topic: '存储', choice: 'Postgres' }, rawArgs: '{"topic":"存储","choice":"Postgres"}' }, { id: 'call_2', name: 'finish', args: {}, rawArgs: '{broken' }])
    expect(response).toMatchObject({ text: '', stopReason: 'tool_calls', model: 'deepseek-chat', usage: { inputTokens: 10, outputTokens: 2 } })
    expect(fromOpenAiResponse({ choices: [{ finish_reason: 'length', message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] })).toMatchObject({ text: 'ab', stopReason: 'length', toolCalls: [] })
    expect(() => fromOpenAiResponse({ error: 'nope' })).toThrow(LlmError)
  })
})

describe('Anthropic Messages translation', () => {
  it('builds a messages body: system folded, tool_use blocks, merged tool_result + text user turn', () => {
    const body = toAnthropicBody(config({ provider: 'anthropic' }), { ...conversation, messages: [{ role: 'system', content: '补充系统提示' }, ...conversation.messages] })
    expect(body.system).toBe('你是判官\n\n补充系统提示')
    const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(messages[1]!.content).toEqual([{ type: 'text', text: '我先看一下' }, { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.txt' } }, { type: 'tool_use', id: 'c2', name: 'read_file', input: { path: 'b.txt' } }])
    expect(messages[2]!.content).toEqual([{ type: 'tool_result', tool_use_id: 'c1', content: 'A' }, { type: 'tool_result', tool_use_id: 'c2', content: 'DENIED: no', is_error: true }, { type: 'text', text: '人刚刚补充了约束' }])
    expect(body.tools).toEqual([{ name: 'read_file', description: '读文件', input_schema: conversation.tools![0]!.parameters }])
    expect(body).toMatchObject({ model: 'gpt-test', max_tokens: 4096, tool_choice: { type: 'auto' } })
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('response_format')
  })

  it('parses content blocks and stop reasons', () => {
    const response = fromAnthropicResponse({ model: 'claude-opus-5', stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 6 }, content: [{ type: 'text', text: '好的' }, { type: 'tool_use', id: 'toolu_1', name: 'write_file', input: { path: 'x' } }] })
    expect(response).toMatchObject({ text: '好的', stopReason: 'tool_calls', toolCalls: [{ id: 'toolu_1', name: 'write_file', args: { path: 'x' } }], usage: { inputTokens: 5, outputTokens: 6 } })
    expect(fromAnthropicResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"a":1}' }] })).toMatchObject({ text: '{"a":1}', stopReason: 'stop' })
    expect(fromAnthropicResponse({ stop_reason: 'refusal', content: [] }).stopReason).toBe('refusal')
    expect(() => fromAnthropicResponse({ type: 'error' })).toThrow(LlmError)
  })

  it('sends x-api-key + anthropic-version headers and no bearer token', async () => {
    const { fetch, calls } = capture(() => json({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] }))
    const client = new LlmClient(config({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-1' }), { fetch })
    await client.chat({ messages: [{ role: 'user', content: 'x' }] })
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages')
    expect(calls[0]!.init.headers).toEqual({ 'content-type': 'application/json', 'x-api-key': 'sk-ant-1', 'anthropic-version': '2023-06-01' })
  })
})

describe('extractJson', () => {
  it('handles fences, surrounding prose, arrays and garbage', () => {
    expect(extractJson('```json\n{"kind":"red"}\n```')).toEqual({ kind: 'red' })
    expect(extractJson('判定如下：{"kind":"blue","alternatives":["a}"]} 以上。')).toEqual({ kind: 'blue', alternatives: ['a}'] })
    expect(extractJson('[1,2]')).toEqual([1, 2])
    expect(() => extractJson('这是一段 {不合法} 的话 [也不合法')).toThrow(LlmError)
    expect(() => extractJson('完全没有 JSON')).toThrow(LlmError)
    expect(() => extractJson('{oops}')).toThrow(LlmError)
  })
})

describe('LlmClient transport', () => {
  it('retries on 429/5xx with backoff and then succeeds', async () => {
    const waits: number[] = []
    const { fetch, calls } = capture((_, index) => index === 0 ? json({ error: 'busy' }, 429) : index === 1 ? json({ error: 'down' }, 503) : json(openaiText('ok')))
    const client = new LlmClient(config(), { fetch, sleep: async (ms) => { waits.push(ms) }, backoffMs: 100 })
    const response = await client.chat({ messages: [{ role: 'user', content: 'x' }] })
    expect(response.text).toBe('ok'); expect(calls).toHaveLength(3); expect(waits).toEqual([100, 200])
    expect(calls[0]!.url).toBe('https://gw.example.com/v1/chat/completions')
    expect(calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer sk-test' })
  })

  it('gives up after the configured retries and surfaces the status', async () => {
    const { fetch, calls } = capture(() => json({ error: 'down' }, 502))
    const client = new LlmClient(config(), { fetch, sleep: async () => {} })
    await expect(client.chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ status: 502, retryable: true })
    expect(calls).toHaveLength(3)
  })

  it('does not retry 4xx and reports non-JSON bodies', async () => {
    const { fetch, calls } = capture(() => json({ error: { message: 'bad model' } }, 400))
    const client = new LlmClient(config(), { fetch, sleep: async () => {} })
    await expect(client.chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ status: 400, retryable: false })
    expect(calls).toHaveLength(1)
    const html = new LlmClient(config(), { fetch: async () => new Response('<html>', { status: 200 }), retries: 0 })
    await expect(html.chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow('不是合法 JSON')
  })

  it('retries network errors, times out per attempt, and never retries a user abort', async () => {
    let attempts = 0
    const flaky = new LlmClient(config(), { fetch: async () => { if (attempts++ === 0) throw new TypeError('fetch failed'); return json(openaiText('recovered')) }, sleep: async () => {} })
    expect((await flaky.chat({ messages: [{ role: 'user', content: 'x' }] })).text).toBe('recovered')

    const hang: FetchLike = (_, init) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    const slow = new LlmClient(config({ timeoutMs: 20 }), { fetch: hang, retries: 0 })
    await expect(slow.chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ retryable: true, message: expect.stringContaining('超时') })

    let hangCalls = 0
    const counting: FetchLike = (url, init) => { hangCalls++; return hang(url, init) }
    const controller = new AbortController()
    const aborted = new LlmClient(config(), { fetch: counting, sleep: async () => {} })
    const pending = aborted.chat({ messages: [{ role: 'user', content: 'x' }], signal: controller.signal })
    setTimeout(() => controller.abort(), 5)
    await expect(pending).rejects.toMatchObject({ retryable: false, message: expect.stringContaining('取消') })
    expect(hangCalls).toBe(1)
  })

  it('json(): asks for json_object, falls back without response_format on 400, and parses leniently', async () => {
    const { fetch, calls } = capture((call) => call.body.response_format ? json({ error: 'response_format unsupported' }, 400) : json(openaiText('```json\n{"ok":true}\n```')))
    const client = new LlmClient(config(), { fetch, sleep: async () => {} })
    expect(await client.json<{ ok: boolean }>({ system: '判官', messages: [{ role: 'user', content: 'x' }] })).toEqual({ ok: true })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.body.response_format).toEqual({ type: 'json_object' })
    expect(calls[1]!.body.response_format).toBeUndefined()
    expect(String((calls[1]!.body.messages as Array<{ content: string }>)[0]!.content)).toContain('JSON')
    const anthropic = new LlmClient(config({ provider: 'anthropic' }), { fetch: async () => json({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"kind":"gray"}' }] }) })
    expect(await anthropic.json({ messages: [{ role: 'user', content: 'x' }] })).toEqual({ kind: 'gray' })
  })
})
