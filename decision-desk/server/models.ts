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

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_call_id?: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
}
export interface Completion {
  content: string
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
  timeoutMs = 120000,
): Promise<Completion> {
  const response = await fetch(completionUrl(config.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...attributionHeaders(),
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]),
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: false,
      ...(tools?.length
        ? {
            tools: tools.map((t) => ({ type: 'function', function: t })),
            tool_choice: 'auto',
            parallel_tool_calls: false,
          }
        : {}),
    }),
  })
  if (!response.ok)
    throw new Error(`模型服务返回 HTTP ${response.status}，请检查地址、模型名称和密钥`)
  const text = await response.text()
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
      messages.push({
        role: 'assistant',
        content: text || null,
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
  if (response.content) blocks.push({ type: 'text', text: response.content })
  for (const c of response.calls)
    blocks.push({ type: 'tool-call', id: ToolCallId(c.id), name: c.name, arguments: c.arguments })
  for (const [index, block] of blocks.entries()) {
    yield { type: 'block-start', index, blockType: block.type }
    if (block.type === 'text') yield { type: 'text-delta', index, text: block.text }
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
      await complete(this.config, wireMessages(options), options.tools, options.signal),
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
