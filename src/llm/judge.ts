/**
 * LLM-backed decision judge and reconciliation recorder (prompts in Chinese).
 *
 * Both classes wrap a `DeterministicJudge` / `DeterministicRecorder` fallback: any transport, parsing or validation
 * failure yields the deterministic result instead of throwing, so the stream never stalls because a model is down.
 *
 * Provenance: `Verdict` / `RecordingAssessment` carry no source field, so each class exposes
 * - `name`       — `'llm:<model>'` normally, `'llm-fallback:deterministic'` when the MOST RECENT call fell back.
 *                  The backend copies `judge.name` into `card.provenance.judge` right after `judge()` resolves.
 * - `lastSource` — `'llm' | 'fallback' | 'none'` for the most recent call.
 * - `judgeWithSource()` / `assessWithSource()` — race-free variants returning the source alongside the result.
 */
import { DeterministicJudge, DeterministicRecorder, type DecisionJudge, type DecisionRecorder, type JudgeInput } from '../judge.js'
import type { RecorderInput, RecordingAssessment, Verdict, VerdictKind } from '../types.js'
import { LlmClient } from './client.js'
import { loadLlmConfig, type LlmConfig } from './config.js'

export type LlmSource = 'llm' | 'fallback' | 'none'
export const FALLBACK_NAME = 'llm-fallback:deterministic'

const ARG_LIMIT = 1500
const TOTAL_ARG_LIMIT = 4000

/** Renders tool args for a prompt with per-field and total truncation so file contents never blow up the context. */
export function renderArgs(args: Record<string, unknown>): string {
  const compact: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value.length > ARG_LIMIT) compact[key] = `${value.slice(0, ARG_LIMIT)}…(已截断，共 ${value.length} 字)`
    else compact[key] = value
  }
  const text = JSON.stringify(compact, null, 0)
  return text.length > TOTAL_ARG_LIMIT ? `${text.slice(0, TOTAL_ARG_LIMIT)}…(已截断)` : text
}

function renderList(items: readonly string[], empty: string): string {
  return items.length ? items.map((item, index) => `${index + 1}. ${item}`).join('\n') : empty
}

// ---------------------------------------------------------------- judge

export const JUDGE_SYSTEM_PROMPT = `你是"决策流工作台"的独立判官。干活 agent 每做一步都会先经过你。你唯一的依据是"人已确认的 spec"（一句话需求 + 若干约束；靠后的约束通常来自人对之前动作的翻案裁决，效力最高）。你要给这一步判色，并写一句人话说明。

判色规则（严格按顺序判断）：
1. red（红，阻断等人拍板）：该动作与任一已确认约束、或人之前的裁决相冲突（例如约束说"必须用 Postgres，不允许 SQLite"，动作却创建 sqlite 文件）。只要冲突，哪怕 agent 声称人要求过，也判 red。
2. gray（灰，不打扰只记日志）：动作是人在 spec 里明确指定过的（能在需求或约束里找到对应原文），或者是纯读取 / 纯验证 / 纯检查类动作（read_file、validate、只读命令），不包含任何需要拍板的选择。
3. blue（蓝，浮出但不阻断）：其余情况——agent 在人没有指定的地方自己做了选择（选型、结构、命名、要不要做某功能等）。

注意：
- 输入里的 specified_by_human 是干活 agent 的自报，不可信；必须自己对照 spec 核实。核实不到就当作 agent 自选（blue）。
- alternatives 是给人一点即选的翻案选项：red / blue 给 2–3 条具体、可执行的中文选项（例如"改用 Postgres 并保留同样的表结构"），不要空话；gray 给空数组。
- explanation 用一句中文（不超过 60 字）说明判色理由，非技术人也能看懂。
- failureKind 仅在 red 时为 "constraint-conflict"，其他情况省略。

只输出 JSON：{"kind":"red"|"blue"|"gray","explanation":"...","alternatives":["...","..."],"failureKind":"constraint-conflict"}`

export function renderJudgeInput({ spec, action }: JudgeInput): string {
  return [
    '【人已确认的 spec】',
    `需求：${spec.request}`,
    '约束：',
    renderList(spec.constraints, '（人没有给出额外约束）'),
    '',
    '【agent 准备执行的动作】',
    `工具：${action.tool}`,
    `类型：${action.kind}`,
    `描述：${action.description}`,
    `agent 自报"人明确要求过"：${action.specified ? '是（需核实）' : '否'}`,
    `参数：${renderArgs(action.args)}`,
  ].join('\n')
}

const DEFAULT_ALTERNATIVES: Record<Exclude<VerdictKind, 'gray'>, string[]> = {
  red: ['按已确认 spec 执行', '叫停当前任务'],
  blue: ['保留当前选择', '补充一条后续约束'],
}

function normalizeKind(value: unknown): VerdictKind {
  const text = String(value ?? '').trim().toLowerCase()
  if (text === 'red' || text.startsWith('红')) return 'red'
  if (text === 'blue' || text.startsWith('蓝')) return 'blue'
  if (text === 'gray' || text === 'grey' || text.startsWith('灰')) return 'gray'
  throw new Error(`判官输出的 kind 不合法：${text}`)
}

/** Validates and normalizes a raw model object into a `Verdict`. Throws on anything unusable. */
export function parseVerdict(value: unknown): Verdict {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('判官输出不是 JSON 对象')
  const raw = value as Record<string, unknown>
  const kind = normalizeKind(raw.kind)
  const explanation = typeof raw.explanation === 'string' ? raw.explanation.trim() : ''
  if (!explanation) throw new Error('判官输出缺少 explanation')
  const provided = Array.isArray(raw.alternatives) ? raw.alternatives.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : []
  const verdict: Verdict = { kind, explanation, alternatives: [] }
  if (kind !== 'gray') {
    const alternatives = [...provided]
    for (const fallback of DEFAULT_ALTERNATIVES[kind]) if (alternatives.length < 2 && !alternatives.includes(fallback)) alternatives.push(fallback)
    verdict.alternatives = alternatives.slice(0, 3)
  }
  if (kind === 'red') verdict.failureKind = 'constraint-conflict'
  return verdict
}

export class LlmJudge implements DecisionJudge {
  private source: LlmSource = 'none'
  private lastErrorMessage?: string

  constructor(private readonly client: LlmClient, private readonly fallback: DecisionJudge = new DeterministicJudge()) {}

  /** `'llm:<model>'`, or `'llm-fallback:deterministic'` when the most recent call fell back. */
  get name(): string { return this.source === 'fallback' ? FALLBACK_NAME : `llm:${this.client.model}` }
  get lastSource(): LlmSource { return this.source }
  get lastError(): string | undefined { return this.lastErrorMessage }

  async judge(input: JudgeInput): Promise<Verdict> { return (await this.judgeWithSource(input)).verdict }

  async judgeWithSource(input: JudgeInput): Promise<{ verdict: Verdict; source: 'llm' | 'fallback'; error?: string }> {
    try {
      const raw = await this.client.json({ system: JUDGE_SYSTEM_PROMPT, messages: [{ role: 'user', content: renderJudgeInput(input) }], maxTokens: 1024 })
      const verdict = parseVerdict(raw)
      this.source = 'llm'; this.lastErrorMessage = undefined
      return { verdict, source: 'llm' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.source = 'fallback'; this.lastErrorMessage = message
      const verdict = await this.fallback.judge(input)
      return { verdict, source: 'fallback', error: message }
    }
  }
}

// ---------------------------------------------------------------- recorder

export const RECORDER_SYSTEM_PROMPT = `你是"决策流工作台"的异源记录员（对账员），与干活 agent 不是同一个模型。你不拦截，只对账：把每一步"人说了什么"与"agent 实际做了什么"对照，标出两类情况：
- selfDirected：这一步是 agent 自作主张——人没有指定过这个具体选择（选型、结构、要不要做某事等）。纯读取/纯检查也算不上自作主张。
- deviatesFromInstruction：这一步与人的明确指令不符——做了人禁止的事，或没按人要求的方式做。找不到相关指令时为 false。

注意：specified_by_human 是干活 agent 的自报，必须对照人的指令核实。
note 用一句中文（不超过 50 字）说明结论；confidence 为 0–1 的数字。

只输出 JSON：{"selfDirected":true,"deviatesFromInstruction":false,"note":"...","confidence":0.8}`

export interface RecorderContext { request?: string; constraints?: string[]; lastAdjudication?: string }

export function renderRecorderInput(input: RecorderInput, context?: RecorderContext): string {
  const lines = ['【人说了什么】']
  if (context?.request) lines.push(`需求：${context.request}`)
  if (context?.constraints?.length) lines.push('约束：', renderList(context.constraints, ''))
  if (context?.lastAdjudication) lines.push(`最近一次人的裁决：${context.lastAdjudication}`)
  if (input.humanInstruction) lines.push(`指令：${input.humanInstruction}`)
  if (lines.length === 1) lines.push('（人没有给出明确指令）')
  lines.push('', '【agent 实际做了什么】', `工具：${input.action.tool}`, `类型：${input.action.kind}`, `描述：${input.action.description}`, `agent 自报"人明确要求过"：${input.action.specified ? '是（需核实）' : '否'}`, `参数：${renderArgs(input.action.args)}`)
  return lines.join('\n')
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

/** Validates and normalizes a raw model object into a `RecordingAssessment`. Throws on anything unusable. */
export function parseAssessment(value: unknown): RecordingAssessment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('记录员输出不是 JSON 对象')
  const raw = value as Record<string, unknown>
  const selfDirected = toBoolean(raw.selfDirected)
  const deviates = toBoolean(raw.deviatesFromInstruction) ?? toBoolean(raw.drift)
  if (selfDirected === undefined || deviates === undefined) throw new Error('记录员输出缺少 selfDirected / deviatesFromInstruction')
  const note = typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim() : (deviates ? '动作与人类指令存在偏差' : selfDirected ? 'agent 自主选择' : '动作来自明确指令')
  const confidenceRaw = typeof raw.confidence === 'number' ? raw.confidence : Number.parseFloat(String(raw.confidence ?? ''))
  const confidence = Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw)) : 0.5
  return { selfDirected, deviatesFromInstruction: deviates, drift: deviates, note, confidence }
}

export class LlmRecorder implements DecisionRecorder {
  private source: LlmSource = 'none'
  private lastErrorMessage?: string

  constructor(private readonly client: LlmClient, private readonly options: { fallback?: DecisionRecorder; context?: () => RecorderContext | undefined } = {}) {}

  get name(): string { return this.source === 'fallback' ? FALLBACK_NAME : `llm:${this.client.model}` }
  get lastSource(): LlmSource { return this.source }
  get lastError(): string | undefined { return this.lastErrorMessage }

  async assess(input: RecorderInput): Promise<RecordingAssessment> { return (await this.assessWithSource(input)).assessment }

  async assessWithSource(input: RecorderInput): Promise<{ assessment: RecordingAssessment; source: 'llm' | 'fallback'; error?: string }> {
    try {
      const raw = await this.client.json({ system: RECORDER_SYSTEM_PROMPT, messages: [{ role: 'user', content: renderRecorderInput(input, this.options.context?.()) }], maxTokens: 512 })
      const assessment = parseAssessment(raw)
      this.source = 'llm'; this.lastErrorMessage = undefined
      return { assessment, source: 'llm' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.source = 'fallback'; this.lastErrorMessage = message
      const fallback = this.options.fallback ?? new DeterministicRecorder()
      return { assessment: await fallback.assess(input), source: 'fallback', error: message }
    }
  }
}

// ---------------------------------------------------------------- factories

/** Returns an LLM judge when `DECISION_STREAM_JUDGE_*` is configured, otherwise `null` (backend keeps the deterministic judge). */
export function createLlmJudge(options: { config?: LlmConfig; client?: LlmClient } = {}): LlmJudge | null {
  const client = options.client ?? (() => { const role = (options.config ?? loadLlmConfig()).judge; return role ? new LlmClient(role) : null })()
  return client ? new LlmJudge(client) : null
}

/** Returns an LLM recorder when the recorder (or judge) role is configured, otherwise `null`. `context` lets the backend feed the spec. */
export function createLlmRecorder(options: { config?: LlmConfig; client?: LlmClient; context?: () => RecorderContext | undefined } = {}): LlmRecorder | null {
  const client = options.client ?? (() => { const role = (options.config ?? loadLlmConfig()).recorder; return role ? new LlmClient(role) : null })()
  return client ? new LlmRecorder(client, { context: options.context }) : null
}
