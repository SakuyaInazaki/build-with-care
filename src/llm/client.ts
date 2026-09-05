/**
 * One `chat()` abstraction over two wire protocols, using only the global `fetch`:
 * - `openai`    → `POST <baseUrl>/chat/completions` (OpenAI, DeepSeek, Gemini/domestic gateways, LiteLLM, OneAPI …)
 * - `anthropic` → `POST <baseUrl>/v1/messages` (Claude Messages API or a compatible gateway)
 *
 * Protocol translation lives in the pure `toOpenAiBody` / `fromOpenAiResponse` / `toAnthropicBody` /
 * `fromAnthropicResponse` functions so it can be unit-tested without network access.
 * Retries: 2 (exponential backoff) on 429 / 5xx / network / timeout. User aborts are never retried.
 */
import type { LlmProvider, LlmRoleConfig } from './config.js'

export type JsonSchema = Record<string, unknown>
export interface ToolDefinition { name: string; description: string; parameters: JsonSchema }
export interface ToolCall { id: string; name: string; args: Record<string, unknown>; rawArgs?: string }

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean }

export interface ChatRequest {
  system?: string
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  toolChoice?: 'auto' | 'none' | 'required'
  /** Ask the provider for a JSON object (OpenAI `response_format`; no-op on Anthropic, which relies on the prompt). */
  jsonMode?: boolean
  maxTokens?: number
  signal?: AbortSignal
}

export type StopReason = 'stop' | 'tool_calls' | 'length' | 'refusal' | 'other'
export interface ChatResponse {
  text: string
  toolCalls: ToolCall[]
  stopReason: StopReason
  model?: string
  usage?: { inputTokens?: number; outputTokens?: number }
  raw: unknown
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>
export interface LlmClientOptions {
  fetch?: FetchLike
  /** Retries after the first attempt (default 2). */
  retries?: number
  /** Base backoff in ms, doubled per retry (default 500). */
  backoffMs?: number
  sleep?: (ms: number) => Promise<void>
}

export class LlmError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false, readonly body?: string) {
    super(message); this.name = 'LlmError'
  }
}

export const DEFAULT_MAX_TOKENS = 4096
const ANTHROPIC_VERSION = '2023-06-01'

/** Resolves the request URL from a base URL, tolerating bases with or without the trailing path segment. */
export function endpointFor(config: Pick<LlmRoleConfig, 'provider' | 'baseUrl'>): string {
  const base = config.baseUrl.replace(/\/+$/, '')
  if (config.provider === 'anthropic') {
    if (/\/v1\/messages$/.test(base)) return base
    if (/\/v1$/.test(base)) return `${base}/messages`
    return `${base}/v1/messages`
  }
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`
}

function headersFor(config: Pick<LlmRoleConfig, 'provider' | 'apiKey'>): Record<string, string> {
  if (config.provider === 'anthropic') return { 'content-type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': ANTHROPIC_VERSION }
  return { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` }
}

function parseArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return {}
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {} } catch { /* fall through to lenient extraction */ }
  try { const parsed = extractJson(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {} } catch { return {} }
}

// ---------------------------------------------------------------- OpenAI-compatible

export function toOpenAiBody(config: Pick<LlmRoleConfig, 'model'>, request: ChatRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = []
  if (request.system) messages.push({ role: 'system', content: request.system })
  for (const message of request.messages) {
    if (message.role === 'system' || message.role === 'user') { messages.push({ role: message.role, content: message.content }); continue }
    if (message.role === 'assistant') {
      const entry: Record<string, unknown> = { role: 'assistant', content: message.content || (message.toolCalls?.length ? null : '') }
      if (message.toolCalls?.length) entry.tool_calls = message.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.rawArgs ?? JSON.stringify(call.args) } }))
      messages.push(entry); continue
    }
    messages.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content })
  }
  const body: Record<string, unknown> = { model: config.model, messages, max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS, stream: false }
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
    if (request.toolChoice) body.tool_choice = request.toolChoice
  }
  if (request.jsonMode) body.response_format = { type: 'json_object' }
  return body
}

export function fromOpenAiResponse(json: unknown): ChatResponse {
  const root = (json ?? {}) as { choices?: unknown[]; model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } }
  const choice = Array.isArray(root.choices) ? root.choices[0] as { message?: Record<string, unknown>; finish_reason?: string } | undefined : undefined
  if (!choice) throw new LlmError('响应缺少 choices', undefined, false, JSON.stringify(json).slice(0, 300))
  const message = choice.message ?? {}
  const content = message.content
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => typeof part === 'string' ? part : String((part as { text?: string })?.text ?? '')).join('') : ''
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls as Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> : []
  const toolCalls: ToolCall[] = rawCalls.filter((call) => typeof call?.function?.name === 'string').map((call, index) => ({
    id: call.id ?? `call_${index}`,
    name: call.function!.name!,
    args: parseArgs(call.function!.arguments),
    rawArgs: typeof call.function!.arguments === 'string' ? call.function!.arguments : undefined,
  }))
  const finish = choice.finish_reason
  const stopReason: StopReason = toolCalls.length ? 'tool_calls' : finish === 'stop' ? 'stop' : finish === 'length' ? 'length' : finish === 'content_filter' ? 'refusal' : 'other'
  return { text, toolCalls, stopReason, model: root.model, usage: { inputTokens: root.usage?.prompt_tokens, outputTokens: root.usage?.completion_tokens }, raw: json }
}

// ---------------------------------------------------------------- Anthropic Messages API

export function toAnthropicBody(config: Pick<LlmRoleConfig, 'model'>, request: ChatRequest): Record<string, unknown> {
  type Block = Record<string, unknown>
  const messages: Array<{ role: 'user' | 'assistant'; content: Block[] }> = []
  const systemParts: string[] = request.system ? [request.system] : []
  const pushUserBlock = (block: Block): void => {
    const last = messages.at(-1)
    if (last && last.role === 'user') last.content.push(block)
    else messages.push({ role: 'user', content: [block] })
  }
  for (const message of request.messages) {
    if (message.role === 'system') {
      // Leading system messages fold into the top-level system prompt; later ones become user text (portable across gateways).
      if (messages.length === 0) systemParts.push(message.content); else pushUserBlock({ type: 'text', text: message.content })
    } else if (message.role === 'user') {
      pushUserBlock({ type: 'text', text: message.content })
    } else if (message.role === 'assistant') {
      const content: Block[] = []
      if (message.content) content.push({ type: 'text', text: message.content })
      for (const call of message.toolCalls ?? []) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args })
      messages.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '(无输出)' }] })
    } else {
      const block: Block = { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }
      if (message.isError) block.is_error = true
      pushUserBlock(block)
    }
  }
  const body: Record<string, unknown> = { model: config.model, max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS, messages }
  if (systemParts.length) body.system = systemParts.join('\n\n')
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }))
    if (request.toolChoice === 'none') body.tool_choice = { type: 'none' }
    else if (request.toolChoice === 'required') body.tool_choice = { type: 'any' }
    else if (request.toolChoice === 'auto') body.tool_choice = { type: 'auto' }
  }
  return body
}

export function fromAnthropicResponse(json: unknown): ChatResponse {
  const root = (json ?? {}) as { content?: unknown; stop_reason?: string; model?: string; usage?: { input_tokens?: number; output_tokens?: number } }
  if (!Array.isArray(root.content)) throw new LlmError('响应缺少 content', undefined, false, JSON.stringify(json).slice(0, 300))
  const blocks = root.content as Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>
  const text = blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('')
  const toolCalls: ToolCall[] = blocks.filter((block) => block.type === 'tool_use' && typeof block.name === 'string').map((block, index) => ({
    id: block.id ?? `toolu_${index}`, name: block.name!, args: parseArgs(block.input),
  }))
  const stop = root.stop_reason
  const stopReason: StopReason = stop === 'tool_use' ? 'tool_calls' : stop === 'end_turn' || stop === 'stop_sequence' ? 'stop' : stop === 'max_tokens' ? 'length' : stop === 'refusal' ? 'refusal' : toolCalls.length ? 'tool_calls' : 'other'
  return { text, toolCalls, stopReason, model: root.model, usage: { inputTokens: root.usage?.input_tokens, outputTokens: root.usage?.output_tokens }, raw: json }
}

// ---------------------------------------------------------------- JSON extraction

/** Extracts the first balanced JSON object/array, ignoring braces inside JSON strings. */
export function extractJson(text: string): unknown {
  const stripped = text.replace(/```(?:json|JSON)?\s*([\s\S]*?)```/g, '$1').trim()
  const candidates = [stripped]
  for (let start = 0; start < stripped.length; start++) {
    if (stripped[start] !== '{' && stripped[start] !== '[') continue
    const open = stripped[start]
    const close = open === '{' ? '}' : ']'
    const stack: string[] = []
    let quoted = false
    let escaped = false
    for (let i = start; i < stripped.length; i++) {
      const char = stripped[i]
      if (quoted) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') quoted = false
        continue
      }
      if (char === '"') { quoted = true; continue }
      if (char === '{' || char === '[') stack.push(char)
      else if (char === '}' || char === ']') {
        const expected = stack.at(-1) === '{' ? '}' : ']'
        if (char !== expected) break
        stack.pop()
        if (!stack.length) { candidates.push(stripped.slice(start, i + 1)); break }
      }
    }
  }
  for (const candidate of candidates) {
    if (!candidate) continue
    try { return JSON.parse(candidate) } catch { /* try the next span */ }
  }
  throw new LlmError(`无法从模型输出中解析 JSON：${stripped.slice(0, 200)}`)
}

// ---------------------------------------------------------------- client

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class LlmClient {
  private readonly fetchImpl: FetchLike
  private readonly retries: number
  private readonly backoffMs: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(readonly config: LlmRoleConfig, options: LlmClientOptions = {}) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init))
    this.retries = options.retries ?? 2
    this.backoffMs = options.backoffMs ?? 500
    this.sleep = options.sleep ?? defaultSleep
  }

  get provider(): LlmProvider { return this.config.provider }
  get model(): string { return this.config.model }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body = this.config.provider === 'anthropic' ? toAnthropicBody(this.config, request) : toOpenAiBody(this.config, request)
    const url = endpointFor(this.config)
    let lastError: LlmError | undefined
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (request.signal?.aborted) throw new LlmError('请求已取消', undefined, false)
      if (attempt > 0) await this.sleep(this.backoffMs * 2 ** (attempt - 1))
      try {
        const json = await this.send(url, body, request.signal)
        return this.config.provider === 'anthropic' ? fromAnthropicResponse(json) : fromOpenAiResponse(json)
      } catch (error) {
        const llmError = error instanceof LlmError ? error : new LlmError(error instanceof Error ? error.message : String(error), undefined, true)
        if (!llmError.retryable || attempt === this.retries) throw llmError
        lastError = llmError
      }
    }
    throw lastError ?? new LlmError('请求失败')
  }

  /**
   * Requests a strict JSON object and parses it leniently. On the OpenAI protocol the first attempt uses
   * `response_format: json_object`; if the gateway rejects that with 400 the call is retried once without it.
   */
  async json<T = unknown>(request: ChatRequest): Promise<T> {
    const instruction = '只输出一个 JSON 对象（合法 JSON），不要 Markdown 代码块，不要任何解释文字。'
    const system = [request.system, instruction].filter(Boolean).join('\n\n')
    const attempt = (jsonMode: boolean): Promise<ChatResponse> => this.chat({ ...request, system, jsonMode })
    let response: ChatResponse
    try {
      response = await attempt(this.config.provider === 'openai')
    } catch (error) {
      if (error instanceof LlmError && error.status === 400 && this.config.provider === 'openai') response = await attempt(false)
      else throw error
    }
    return extractJson(response.text) as T
  }

  private async send(url: string, body: Record<string, unknown>, signal: AbortSignal | undefined): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response: Response
    try {
      response = await this.fetchImpl(url, { method: 'POST', headers: headersFor(this.config), body: JSON.stringify(body), signal: combined })
    } catch (error) {
      if (signal?.aborted) throw new LlmError('请求已取消', undefined, false)
      if (timeout.aborted) throw new LlmError(`请求超时（${this.config.timeoutMs}ms）`, undefined, true)
      throw new LlmError(`网络错误：${error instanceof Error ? error.message : String(error)}`, undefined, true)
    }
    const text = await response.text()
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500
      throw new LlmError(`HTTP ${response.status}：${text.slice(0, 300)}`, response.status, retryable, text)
    }
    try { return JSON.parse(text) } catch { throw new LlmError('响应不是合法 JSON', response.status, false, text.slice(0, 300)) }
  }
}
