/**
 * Real tool-calling agent loop implementing `Runner` on top of `DecisionStream`.
 *
 * Every model tool call becomes one `stream.execute(action)`: the judge colours it, red cards block until the human
 * decides, and the tool result returned to the model is either the executor output or `DENIED: <reason>` (D4-Y: the
 * deny reason is fed back to the model). Constraints the human injects (翻案 / post-hoc) are diffed against what the
 * model has already seen and appended as a "人刚刚补充了约束" message before the next model call.
 *
 * Status: running → waiting-human (a red card of this agent is pending) → running → done | failed | cancelled.
 * `start()` never rejects; errors land in `status.message`.
 */
import type { DecisionStream } from '../stream.js'
import type { Runner, RunnerStatus } from '../runner-types.js'
import type { ActionInput, ActionResult, StructuredDecision, WorkUnitInput } from '../types.js'
import { LlmClient, type ChatMessage, type ToolCall, type ToolDefinition } from './client.js'
import { loadLlmConfig, type LlmConfig } from './config.js'

export const DEFAULT_MAX_STEPS = 12
export const DEFAULT_AGENT_ID = 'llm-agent'
export const ALLOWED_COMMANDS = ['node --version', 'npm test', 'npm run build', 'npm run typecheck'] as const

const specifiedByHuman = {
  specified_by_human: { type: 'boolean', description: '仅当人在需求或约束里明确要求了这一步时为 true；由你自己决定的一律 false（默认 false）。判官会核对。', default: false },
}

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: 'begin_unit',
    description: '先申报一个语义工作单元及其中的设计决定；通过后再调用具体工具。',
    parameters: { type: 'object', properties: { goal: { type: 'string' }, decisions: { type: 'array', items: { type: 'object', properties: { domain: { type: 'string' }, choice: { type: 'string' }, rationale: { type: 'string' }, specifiedByHuman: { type: 'boolean' } }, required: ['domain', 'choice'] } }, specified_by_human: { type: 'boolean' } }, required: ['goal', 'decisions'] },
  },
  {
    name: 'write_file',
    description: '在沙箱工作区里写入（或覆盖）一个文件。path 为工作区内的相对路径，不能越出工作区。',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '相对路径，如 src/index.ts' }, content: { type: 'string', description: '完整文件内容' }, description: { type: 'string', description: '一句中文说明这个文件做什么、其中做了什么选择' }, ...specifiedByHuman }, required: ['path', 'content', 'description'] },
  },
  {
    name: 'read_file',
    description: '读取工作区内一个文件的内容。',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '相对路径' }, ...specifiedByHuman }, required: ['path'] },
  },
  {
    name: 'run_command',
    description: `在工作区根目录运行一条命令。执行器只允许这几条：${ALLOWED_COMMANDS.join(' / ')}；其他命令一律被拒绝。`,
    parameters: { type: 'object', properties: { command: { type: 'string', description: '命令原文' }, ...specifiedByHuman }, required: ['command'] },
  },
  {
    name: 'validate',
    description: '声明并执行一次验证 / 检查（例如"检查 schema 与约束一致"）。target 为被检查的文件或对象。通过的检查会让对应的块变绿。',
    parameters: { type: 'object', properties: { description: { type: 'string', description: '检查内容（中文）' }, target: { type: 'string', description: '被检查的文件或对象' }, ...specifiedByHuman }, required: ['description', 'target'] },
  },
  {
    name: 'decide',
    description: '记录一个不直接产生文件的设计决定（存储选型、框架、目录结构、是否做登录等）。凡是 spec 没写死、由你来定的事，先调用它再动手写文件。',
    parameters: { type: 'object', properties: { topic: { type: 'string', description: '决定的主题，如"存储方案"' }, choice: { type: 'string', description: '你的选择' }, reason: { type: 'string', description: '一句理由（中文）' }, ...specifiedByHuman }, required: ['topic', 'choice', 'reason'] },
  },
  {
    name: 'finish',
    description: '任务完成时调用。summary 用中文总结做了什么、哪些是你自己定的。调用后不再有后续步骤。',
    parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
  },
  { name: 'end_unit', description: '结束当前工作单元并总结其结果。', parameters: { type: 'object', properties: { summary: { type: 'string' }, specified_by_human: { type: 'boolean' } }, required: ['summary'] } },
]

export interface LlmRunnerOptions {
  request?: string
  maxSteps?: number
  workspaceRoot: string
  agentId?: string
  /** Pre-loaded config (default: `loadLlmConfig()`). */
  config?: LlmConfig
  /** Injected client (tests); bypasses config. */
  client?: LlmClient
  /** Interval for detecting a pending red card while `execute()` is in flight (default 50 ms). */
  pollIntervalMs?: number
}

interface ResolvedOptions { request?: string; maxSteps: number; workspaceRoot: string; agentId: string; model: string; pollIntervalMs: number }

export function buildSystemPrompt(options: Pick<ResolvedOptions, 'workspaceRoot' | 'maxSteps'>): string {
  return `你是一个在沙箱工作区里干活的编码 agent，正在为人搭一个小项目。工作区根目录：${options.workspaceRoot}（所有路径使用相对路径，不能越出工作区）。

工作方式：
1. 每一步都必须通过工具调用完成，不要只用文字描述你打算做什么。一次只做一步。
2. 在 spec 没有写死、需要你自己拍板的地方（存储选型、框架、目录结构、是否做某功能……），先调用 decide 记录决定，再动手写文件。
3. 工具结果以 "DENIED:" 开头表示人拒绝了这一步，并给出了理由或新约束。你必须在之后的所有步骤里遵守它：不要重试相同的动作，改用符合要求的做法。
  4. 人可能随时补充约束，会以新增约束消息出现，同样必须遵守。
5. 每个工具都有 specified_by_human 参数：只有当人在需求或约束里明确要求了这一步时才填 true；你自己决定的一律 false。如实填写，判官会核对。
6. 可用命令只有：${ALLOWED_COMMANDS.join(' / ')}。
7. 项目要小而完整：最多 ${options.maxSteps} 步工具调用。写完关键文件后调用 finish，用中文总结做了什么、哪些是你自己定的。
  8. 先调用 begin_unit 申报语义单元，单元内再调用工具；单元完成后调用 end_unit。所有说明、描述、总结都用中文。`
}

export function renderTask(request: string, constraints: readonly string[]): string {
  const list = constraints.length ? constraints.map((item, index) => `${index + 1}. ${item}`).join('\n') : '（人没有给出额外约束）'
  return `【需求】${request}\n【已确认的约束】\n${list}\n\n请开始，通过工具调用逐步完成。`
}

export function renderInjectedConstraints(constraints: readonly string[]): string {
  return `人刚刚补充了约束：\n${constraints.map((item) => `- ${item}`).join('\n')}\n后续所有步骤都必须遵守。`
}

const asString = (value: unknown): string => typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)

/** Maps a model tool call onto an `ActionInput` for the stream; `null` for unknown tools. */
export function toAction(call: ToolCall, agentId: string): ActionInput | null {
  const args = call.args
  const specified = args.specified_by_human === true
  const text = (key: string): string => asString(args[key]).trim()
  switch (call.name) {
    case 'write_file': return { tool: 'write_file', kind: 'write', description: text('description') || `写入文件 ${text('path')}`, args: { path: text('path'), content: asString(args.content) }, specified, agentId }
    case 'read_file': return { tool: 'read_file', kind: 'read', description: `读取文件 ${text('path')}`, args: { path: text('path') }, specified, agentId }
    case 'run_command': return { tool: 'run_command', kind: 'command', description: `运行命令 ${text('command')}`, args: { command: text('command') }, specified, agentId }
    case 'validate': return { tool: 'validate', kind: 'validate', description: text('description') || `检查 ${text('target')}`, args: { target: text('target') }, specified, agentId }
    case 'decide': return { tool: 'decide', kind: 'write', description: `决定${text('topic')}：${text('choice')}`, args: { topic: text('topic'), choice: text('choice'), reason: text('reason') }, specified, agentId }
    default: return null
  }
}

const OUTPUT_LIMIT = 6000
const clip = (value: unknown): string => { const text = typeof value === 'string' ? value : JSON.stringify(value ?? ''); return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}…(已截断)` : text }

/** Turns an `ActionResult` into the tool result string the model sees. `DENIED:` = human rejected; `ERROR:` = runtime failure. */
export function describeResult(call: ToolCall, action: ActionInput, result: ActionResult): string {
  const { card } = result
  if (result.allowed) {
    const output = result.toolResult?.output
    switch (call.name) {
      case 'read_file': return clip(output)
      case 'run_command': return `OK: 命令已执行\n${clip(output)}`
      case 'write_file': return `OK: 已写入 ${asString(action.args.path)}`
      case 'validate': return `OK: 检查已记录${card.verificationStatus === 'passed' ? '并通过' : ''}：${action.description}`
      case 'decide': return `OK: 已记录决定「${asString(action.args.choice)}」`
      default: return `OK: ${clip(output)}`
    }
  }
  if (card.decisionStatus === 'overridden' || card.decisionStatus === 'cancelled') {
    const constraint = card.appliedConstraint ? `\n人的要求：${card.appliedConstraint}` : ''
    return `DENIED: ${result.reason ?? '人拒绝了这个动作'}${constraint}`
  }
  return `ERROR: ${result.toolResult?.error ?? result.reason ?? '执行失败'}`
}

const TERMINAL: ReadonlySet<RunnerStatus['state']> = new Set(['done', 'failed', 'cancelled'])

export class LlmAgentRunner implements Runner {
  private current: RunnerStatus
  private readonly listeners = new Set<(status: RunnerStatus) => void>()
  private readonly controller = new AbortController()
  private readonly messages: ChatMessage[] = []
  private sentConstraints: string[] = []
  private started = false
  private currentUnitId?: string

  constructor(private readonly stream: DecisionStream, private readonly client: LlmClient, private readonly options: ResolvedOptions) {
    this.current = { kind: 'llm', state: 'idle', model: options.model, steps: 0 }
  }

  get status(): RunnerStatus { return { ...this.current } }
  /** Conversation so far (for debugging / the timeline); not part of `Runner`. */
  get transcript(): readonly ChatMessage[] { return this.messages }

  subscribe(listener: (status: RunnerStatus) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  cancel(reason = '已被人工叫停'): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason)
    this.finish('cancelled', reason)
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    try {
      await this.run()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.finish(this.controller.signal.aborted ? 'cancelled' : 'failed', message)
    }
  }

  private get terminal(): boolean { return TERMINAL.has(this.current.state) }

  private update(patch: Partial<RunnerStatus>): void {
    this.current = { ...this.current, ...patch }
    const snapshot = this.status
    for (const listener of this.listeners) { try { listener(snapshot) } catch { /* listeners never break the loop */ } }
  }

  private finish(state: 'done' | 'failed' | 'cancelled', message?: string): void {
    if (this.terminal) return
    this.update({ state, message, waitingCardId: undefined, finishedAt: new Date().toISOString() })
  }

  private async run(): Promise<void> {
    const spec = this.stream.spec
    if (!spec) { this.finish('failed', '尚未确认 spec，无法启动 LLM agent'); return }
    if (this.controller.signal.aborted) { this.finish('cancelled', String(this.controller.signal.reason ?? '已取消')); return }
    this.update({ state: 'running', startedAt: new Date().toISOString(), steps: 0, message: undefined })
    const request = this.options.request?.trim() || spec.request
    this.sentConstraints = [...spec.constraints]
    this.messages.push({ role: 'user', content: renderTask(request, spec.constraints) })
    const system = buildSystemPrompt(this.options)
    let textOnlyReplies = 0

    while (!this.terminal) {
      if ((this.current.steps ?? 0) >= this.options.maxSteps) { this.finish('done', `已达到最大步数 ${this.options.maxSteps}，自动停止`); return }
      this.injectNewConstraints()
      const response = await this.client.chat({ system, messages: this.messages, tools: AGENT_TOOLS, toolChoice: 'auto', maxTokens: 8192, signal: this.controller.signal })
      if (this.terminal) return
      this.messages.push({ role: 'assistant', content: response.text, toolCalls: response.toolCalls })

      if (response.toolCalls.length === 0) {
        if (response.stopReason === 'refusal') { this.finish('failed', `模型拒绝了请求：${response.text || '（无说明）'}`); return }
        if (++textOnlyReplies >= 2) { this.finish('done', response.text.trim() || '模型未调用 finish 即结束'); return }
        this.messages.push({ role: 'user', content: '请通过工具调用继续执行；如果已经完成，请调用 finish 并给出总结。' })
        continue
      }
      textOnlyReplies = 0

      for (const call of response.toolCalls) {
        if (this.terminal) return
        if ((this.current.steps ?? 0) >= this.options.maxSteps) { this.pushToolResult(call, 'ERROR: 已达到最大步数，未执行'); continue }
        this.update({ steps: (this.current.steps ?? 0) + 1 })
        if (call.name === 'finish') { this.pushToolResult(call, 'OK'); this.finish('done', asString(call.args.summary).trim() || '任务完成'); return }
        const output = await this.runTool(call)
        if (this.terminal) return
        this.pushToolResult(call, output)
      }
    }
  }

  private pushToolResult(call: ToolCall, content: string): void {
    this.messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content, isError: content.startsWith('DENIED:') || content.startsWith('ERROR:') })
  }

  /** Diffs `stream.spec.constraints` against what the model has seen and appends the new ones as a user message. */
  private injectNewConstraints(): void {
    const constraints = this.stream.spec?.constraints ?? []
    const fresh = constraints.filter((item) => !this.sentConstraints.includes(item))
    if (!fresh.length) return
    this.sentConstraints.push(...fresh)
    this.messages.push({ role: 'user', content: renderInjectedConstraints(fresh) })
  }

  private async runTool(call: ToolCall): Promise<string> {
    if (call.name === 'end_unit') {
      this.currentUnitId = undefined
      return `OK: 单元已结束：${asString(call.args.summary)}`
    }
    if (call.name === 'begin_unit') {
      const decisions = Array.isArray(call.args.decisions) ? call.args.decisions.filter((item): item is StructuredDecision => Boolean(item && typeof item === 'object')).map((item) => ({ domain: asString(item.domain), choice: asString(item.choice), rationale: typeof item.rationale === 'string' ? item.rationale : undefined, specifiedByHuman: item.specifiedByHuman === true })) : []
      const unit: WorkUnitInput = { goal: asString(call.args.goal), decisions, toolCalls: [], agentId: this.options.agentId }
      const watcher = this.watchForGate()
      try {
        const result = await this.stream.executeUnit(unit, { signal: this.controller.signal })
        if (result.allowed) this.currentUnitId = result.card.id
        return result.allowed ? `OK: 工作单元已批准（${result.card.id}）` : describeResult(call, { tool: 'begin_unit', kind: 'validate', description: unit.goal, args: {} }, result)
      } finally { watcher.stop() }
    }
    const action = toAction(call, this.options.agentId)
    if (!action) return `ERROR: 未知工具 ${call.name}`
    if (call.name === 'run_command' && !(ALLOWED_COMMANDS as readonly string[]).includes(asString(action.args.command))) {
      return `ERROR: 命令不在允许列表内，只允许：${ALLOWED_COMMANDS.join(' / ')}`
    }
    const watcher = this.watchForGate()
    try {
      const result = this.currentUnitId
        ? await this.stream.executeInUnit(this.currentUnitId, action, { signal: this.controller.signal })
        : await this.stream.execute(action, { signal: this.controller.signal })
      if (this.controller.signal.aborted) { this.finish('cancelled', String(this.controller.signal.reason ?? '已取消')); return 'DENIED: 已取消' }
      return describeResult(call, action, result)
    } finally {
      watcher.stop()
      if (!this.terminal) this.update({ state: 'running', waitingCardId: undefined })
    }
  }

  /** Polls `stream.cards` while `execute()` is in flight; a pending red card of this agent flips status to waiting-human. */
  private watchForGate(): { stop(): void } {
    const before = this.stream.cards.length
    const agentId = this.options.agentId
    const timer = setInterval(() => {
      const pending = this.stream.cards.slice(before).find((card) => card.agentId === agentId && card.verdict.kind === 'red' && card.decisionStatus === 'pending' && card.state === 'pending')
      if (pending && this.current.state === 'running') this.update({ state: 'waiting-human', waitingCardId: pending.id })
      else if (!pending && this.current.state === 'waiting-human') this.update({ state: 'running', waitingCardId: undefined })
    }, this.options.pollIntervalMs)
    timer.unref?.()
    return { stop: () => clearInterval(timer) }
  }
}

/** Returns a runner when the agent model is configured (or a client is injected); otherwise `null` → backend answers 409 `llm_not_configured`. */
export function createLlmRunner(stream: DecisionStream, options: LlmRunnerOptions): LlmAgentRunner | null {
  const client = options.client ?? (() => { const role = (options.config ?? loadLlmConfig()).agent; return role ? new LlmClient(role) : null })()
  if (!client) return null
  return new LlmAgentRunner(stream, client, {
    request: options.request,
    maxSteps: Math.max(1, Math.floor(options.maxSteps ?? DEFAULT_MAX_STEPS)),
    workspaceRoot: options.workspaceRoot,
    agentId: options.agentId ?? DEFAULT_AGENT_ID,
    model: client.model,
    pollIntervalMs: options.pollIntervalMs ?? 50,
  })
}
