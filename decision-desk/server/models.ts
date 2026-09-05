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
  const headers = {
    'Content-Type': 'application/json',
    ...attributionHeaders(),
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
  }
  const effort = config.reasoningEffort
  if (
    effort &&
    !(
      isDeepSeekBaseUrl(config.baseUrl) &&
      DEEPSEEK_MODELS.some((model) => model.value === config.model)
    )
  )
    throw new Error('当前模型未配置推理强度支持。')
  const payload = JSON.stringify({
    model: config.model,
    messages,
    stream: false,
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
    private config: ModelConfig,
    private onRequest?: (options: GenerateOptions) => void,
  ) {
    super()
  }
  async *stream(options: GenerateOptions) {
    this.onRequest?.(options)
    yield* responseChunks(
      await complete(this.config, wireMessages(options), options.tools, options.signal, null),
    )
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
