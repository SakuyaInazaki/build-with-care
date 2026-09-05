import {
  LlmAdapter,
  ToolCallId,
  attributionHeaders,
  type ContentBlock,
  type GenerateOptions,
  type StreamChunk,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { ModelConfig } from '../shared/types.js'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { DEEPSEEK_MODELS, isDeepSeekBaseUrl } from '../shared/model-presets.js'

// The execution path has no wall-clock or socket timeout; user cancellation remains active.
function postWithoutDeadline(
  url: string,
  headers: Record<string, string>,
  body: string,
  signal?: AbortSignal,
) {
  return new Promise<string>((resolve, reject) => {
    const request = (url.startsWith('https:') ? httpsRequest : httpRequest)(
      url,
      {
        method: 'POST',
        headers,
        signal,
      },
      (response) => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          response.resume()
          reject(new Error(`模型服务返回 HTTP ${response.statusCode}，请检查地址、模型名称和密钥`))
          return
        }
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > 3_000_000) {
            response.destroy(new Error('模型响应过大'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        response.on('error', reject)
      },
    )
    request.setTimeout(0)
    request.on('error', reject)
    request.end(body)
  })
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  reasoning_content?: string
  tool_call_id?: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
}
export interface Completion {
  content: string
  reasoningContent?: string
  calls: { id: string; name: string; arguments: string }[]
  finishReason: string
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

function requestHeaders(config: ModelConfig) {
  return {
    'Content-Type': 'application/json',
    ...attributionHeaders(),
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
  }
}

function requestPayload(
  config: ModelConfig,
  messages: ChatMessage[],
  tools?: ToolSchema[],
  stream = false,
) {
  const effort = config.reasoningEffort
  if (
    effort &&
    !(isDeepSeekBaseUrl(config.baseUrl) && DEEPSEEK_MODELS.some((m) => m.value === config.model))
  )
    throw new Error('当前模型未配置推理强度支持。')
  return JSON.stringify({
    model: config.model,
    messages,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(effort
      ? effort === 'none'
        ? { thinking: { type: 'disabled' } }
        : { thinking: { type: 'enabled' }, reasoning_effort: effort }
      : {}),
    ...(tools?.length
      ? {
          tools: tools.map((t) => ({ type: 'function', function: t })),
          tool_choice: 'auto',
          parallel_tool_calls: false,
        }
      : {}),
  })
}

function parseCompletion(text: string): Completion {
  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error('模型服务未返回有效 JSON')
  }
  const choice = body.choices?.[0],
    message = choice?.message
  if (!message)
    throw new Error('模型返回中没有 choices[0].message；请使用 Chat Completions 兼容接口')
  return {
    content: typeof message.content === 'string' ? message.content : '',
    ...(typeof message.reasoning_content === 'string'
      ? { reasoningContent: message.reasoning_content }
      : {}),
    calls: (message.tool_calls ?? []).map((c: any) => {
      if (
        !c.id ||
        typeof c.function?.name !== 'string' ||
        typeof c.function?.arguments !== 'string'
      )
        throw new Error('模型工具调用格式不完整')
      return { id: c.id, name: c.function.name, arguments: c.function.arguments }
    }),
    finishReason: choice.finish_reason ?? 'stop',
    usage: body.usage,
  }
}

// Native HTTP avoids fetch's implicit response deadlines. Never execute a partial tool call.
export async function* streamCompletion(
  config: ModelConfig,
  messages: ChatMessage[],
  tools?: ToolSchema[],
  signal?: AbortSignal,
): AsyncIterable<StreamChunk> {
  const url = completionUrl(config.baseUrl)
  const payload = requestPayload(config, messages, tools, true)
  let request: import('node:http').ClientRequest | undefined
  let response: import('node:http').IncomingMessage | undefined
  try {
    response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      request = (url.startsWith('https:') ? httpsRequest : httpRequest)(
        url,
        { method: 'POST', headers: requestHeaders(config), signal },
        resolve,
      )
      request.setTimeout(0)
      request.on('error', reject)
      request.end(payload)
    })
    if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300)
      throw new Error(`模型服务返回 HTTP ${response.statusCode}，请检查地址、模型名称和密钥`)
    if (!response.headers['content-type']?.includes('text/event-stream')) {
      let text = ''
      response.setEncoding('utf8')
      for await (const chunk of response) text += chunk
      const completion = parseCompletion(text)
      if (completion.finishReason === 'length')
        throw new Error('模型服务截断了响应，本次动作未执行。')
      yield* responseChunks(completion)
      return
    }
    const blocks: ContentBlock[] = []
    const toolIndexes = new Map<number, number>()
    let reasoningIndex: number | undefined, textIndex: number | undefined
    let buffer = '',
      finished: string | undefined,
      done = false
    let usage: Completion['usage']
    response.setEncoding('utf8')
    for await (const bytes of response) {
      signal?.throwIfAborted()
      buffer += bytes
      let separator: RegExpExecArray | null
      while ((separator = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
        const frame = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator[0].length)
        const data = frame
          .split(/\r\n|\n|\r/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n')
        if (!data) continue
        if (data === '[DONE]') {
          done = true
          break
        }
        let packet: any
        try {
          packet = JSON.parse(data)
        } catch {
          throw new Error('模型响应流包含无效 JSON，本次动作未执行。')
        }
        if (packet.error) throw new Error('模型服务在生成过程中返回错误，本次动作未执行。')
        if (packet.usage) usage = packet.usage
        const choice = packet.choices?.[0]
        if (!choice) continue
        const delta = choice.delta ?? {}
        for (const [key, type] of [
          ['reasoning_content', 'reasoning'],
          ['content', 'text'],
        ] as const) {
          if (typeof delta[key] !== 'string' || !delta[key]) continue
          let index = type === 'reasoning' ? reasoningIndex : textIndex
          if (index === undefined) {
            index = blocks.length
            blocks.push({ type, text: '' })
            if (type === 'reasoning') reasoningIndex = index
            else textIndex = index
            yield { type: 'block-start', index, blockType: type }
          }
          const block = blocks[index] as { type: 'reasoning' | 'text'; text: string }
          block.text += delta[key]
          yield {
            type: type === 'reasoning' ? 'reasoning-delta' : 'text-delta',
            index,
            text: delta[key],
          }
        }
        for (const call of delta.tool_calls ?? []) {
          if (!Number.isInteger(call.index) || call.index < 0)
            throw new Error('模型工具调用索引无效')
          let index = toolIndexes.get(call.index)
          if (index === undefined) {
            index = blocks.length
            toolIndexes.set(call.index, index)
            blocks.push({ type: 'tool-call', id: ToolCallId(''), name: '', arguments: '' })
            yield { type: 'block-start', index, blockType: 'tool-call' }
          }
          const block = blocks[index] as Extract<ContentBlock, { type: 'tool-call' }>
          const hadId = !!block.id
          if (call.id) block.id = ToolCallId(call.id)
          if (call.function?.name) block.name += call.function.name
          const argumentsDelta = call.function?.arguments ?? ''
          block.arguments += argumentsDelta
          if (block.id)
            yield {
              type: 'tool-call-delta',
              index,
              id: block.id,
              name: block.name || undefined,
              argumentsDelta: hadId ? argumentsDelta : block.arguments,
            }
        }
        if (choice.finish_reason) finished = choice.finish_reason
      }
      if (done) break
    }
    if (!finished) throw new Error('模型响应流意外中断，本次动作未执行。')
    if (!['stop', 'tool_calls'].includes(finished))
      throw new Error('模型服务未完整生成响应，本次动作未执行。')
    for (const [index, block] of blocks.entries()) {
      if (block.type === 'tool-call') {
        if (!block.id || !block.name) throw new Error('模型工具调用格式不完整')
        try {
          JSON.parse(block.arguments)
        } catch {
          throw new Error('模型工具参数不完整，本次动作未执行。')
        }
      }
      yield { type: 'block-end', index, block }
    }
    if (usage)
      yield {
        type: 'usage',
        usage: {
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
        },
      }
    yield { type: 'finish', reason: { kind: toolIndexes.size ? 'tool-calls' : 'stop' } }
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    throw error
  } finally {
    response?.destroy()
    request?.destroy()
  }
}

export async function completeStream(
  config: ModelConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<Completion> {
  let content = ''
  for await (const chunk of streamCompletion(config, messages, undefined, signal)) {
    if (chunk.type === 'text-delta') content += chunk.text
  }
  return { content, calls: [], finishReason: 'stop' }
}

export function completionUrl(baseUrl: string) {
  const url = new URL(baseUrl)
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('模型地址格式不正确')
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('远程模型服务请使用 HTTPS')
  return (
    url
      .toString()
      .replace(/\/+$/, '')
      .replace(/\/chat\/completions$/, '') + '/chat/completions'
  )
}

export async function complete(
  config: ModelConfig,
  messages: ChatMessage[],
  tools?: ToolSchema[],
  signal?: AbortSignal,
  timeoutMs: number | null = 120000,
): Promise<Completion> {
  const timeout = timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs)
  const headers = requestHeaders(config)
  const payload = requestPayload(config, messages, tools)
  let text: string
  try {
    if (!timeout)
      text = await postWithoutDeadline(completionUrl(config.baseUrl), headers, payload, signal)
    else {
      const response = await fetch(completionUrl(config.baseUrl), {
        method: 'POST',
        headers,
        body: payload,
        signal: AbortSignal.any([...(signal ? [signal] : []), timeout]),
      })
      if (!response.ok)
        throw new Error(`模型服务返回 HTTP ${response.status}，请检查地址、模型名称和密钥`)
      text = await response.text()
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    if (timeout?.aborted)
      throw new Error(`模型响应超过 ${Math.ceil(timeoutMs! / 1000)} 秒，本次请求已停止。`)
    throw error
  }
  if (text.length > 3_000_000) throw new Error('模型响应过大')
  return parseCompletion(text)
}

export function wireMessages(options: GenerateOptions): ChatMessage[] {
  const messages: ChatMessage[] = options.system
    ? [{ role: 'system', content: options.system }]
    : []
  for (const m of options.messages) {
    const text = m.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
    const calls = m.content.filter((b) => b.type === 'tool-call')
    const results = m.content.filter((b) => b.type === 'tool-result')
    if (m.role === 'assistant') {
      const reasoning = m.content.filter((block) => block.type === 'reasoning')
      messages.push({
        role: 'assistant',
        content: text || null,
        ...(reasoning.length
          ? { reasoning_content: reasoning.map((block) => block.text).join('') }
          : {}),
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: c.arguments },
              })),
            }
          : {}),
      })
    } else {
      if (text) messages.push({ role: m.role, content: text })
      for (const result of results)
        messages.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          content: JSON.stringify({ isError: !!result.isError, content: result.content }),
        })
    }
  }
  return messages
}

export async function* responseChunks(response: Completion): AsyncIterable<StreamChunk> {
  const blocks: ContentBlock[] = []
  if (response.reasoningContent !== undefined)
    blocks.push({ type: 'reasoning', text: response.reasoningContent })
  if (response.content) blocks.push({ type: 'text', text: response.content })
  for (const c of response.calls)
    blocks.push({ type: 'tool-call', id: ToolCallId(c.id), name: c.name, arguments: c.arguments })
  for (const [index, block] of blocks.entries()) {
    yield { type: 'block-start', index, blockType: block.type }
    if (block.type === 'text') yield { type: 'text-delta', index, text: block.text }
    if (block.type === 'reasoning') yield { type: 'reasoning-delta', index, text: block.text }
    if (block.type === 'tool-call')
      yield {
        type: 'tool-call-delta',
        index,
        id: block.id,
        name: block.name,
        argumentsDelta: block.arguments,
      }
    yield { type: 'block-end', index, block }
  }
  if (response.usage)
    yield {
      type: 'usage',
      usage: {
        inputTokens: response.usage.prompt_tokens ?? 0,
        outputTokens: response.usage.completion_tokens ?? 0,
      },
    }
  yield {
    type: 'finish',
    reason: {
      kind:
        response.finishReason === 'length'
          ? 'max-tokens'
          : response.calls.length
            ? 'tool-calls'
            : 'stop',
    },
  }
}

export class CompatibleAdapter extends LlmAdapter {
  constructor(
    private config: ModelConfig | (() => ModelConfig),
    private onRequest?: (options: GenerateOptions) => void,
  ) {
    super()
  }
  async *stream(options: GenerateOptions) {
    this.onRequest?.(options)
    const config = structuredClone(typeof this.config === 'function' ? this.config() : this.config)
    yield* streamCompletion(config, wireMessages(options), options.tools, options.signal)
  }
}

export function parseModelJson(text: string): unknown {
  const clean = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    return JSON.parse(clean)
  } catch {
    throw new Error('审查模型没有返回有效的结构化结果')
  }
}
