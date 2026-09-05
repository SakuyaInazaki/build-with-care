/**
 * D3-Y: a one-line request is expanded by a model into 2–4 short "confirmed-style" constraints that the human
 * confirms before the agent starts; the confirmed spec is the red/blue baseline.
 *
 * Uses the agent model (the worker expands its own brief), falling back to the judge model when only that is
 * configured. Returns `null` when no model is configured or on any failure so the backend can use its template rules.
 */
import { LlmClient } from './client.js'
import { loadLlmConfig, type LlmConfig } from './config.js'

export interface SpecDraft { request: string; constraints: string[]; source: 'llm' }

export const MAX_CONSTRAINT_LENGTH = 24
export const MIN_CONSTRAINTS = 2
export const MAX_CONSTRAINTS = 4

export const SPEC_DRAFT_SYSTEM_PROMPT = `你是"决策流工作台"的需求扩写助手。人只给了一句话需求，你要把它扩成 2–4 条"已确认约束"风格的短句，供人一眼确认后作为后续红/蓝判色的基线。
要求：
- 每条是一个可核对的硬约束（技术选型、范围边界、必须 / 不允许做的事），不要泛泛的建议；
- 每条用中文，不超过 24 个字，不带序号，不加句号；
- 只写需求里已隐含或最关键的决策点，不替人做过多主张；
- 需求里没说的选型（存储、框架、鉴权等）不要替人定死，留给 agent 拍板、人再翻案。

只输出 JSON：{"constraints":["...","..."]}`

/** Normalizes raw model output into ≤4 trimmed, de-duplicated, ≤30-char constraints. */
export function normalizeConstraints(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (raw as { constraints?: unknown }).constraints : undefined
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const text = item.trim().replace(/^[\d一二三四五六七八九十]+[.、):：）]\s*/, '').replace(/[。；;]$/, '').trim()
    if (!text || text.length > MAX_CONSTRAINT_LENGTH || seen.has(text)) continue
    seen.add(text); out.push(text)
    if (out.length >= MAX_CONSTRAINTS) break
  }
  return out
}

function pickClient(config: LlmConfig): LlmClient | null {
  const role = config.agent ?? config.judge
  return role ? new LlmClient(role) : null
}

export async function draftSpecWithLlm(request: string, options: { config?: LlmConfig; client?: LlmClient } = {}): Promise<SpecDraft | null> {
  const trimmed = request.trim()
  if (!trimmed) return null
  const client = options.client ?? pickClient(options.config ?? loadLlmConfig())
  if (!client) return null
  try {
    const raw = await client.json({ system: SPEC_DRAFT_SYSTEM_PROMPT, messages: [{ role: 'user', content: `一句话需求：${trimmed}` }], maxTokens: 512 })
    const constraints = normalizeConstraints(raw)
    if (constraints.length < MIN_CONSTRAINTS) return null
    return { request: trimmed, constraints, source: 'llm' }
  } catch {
    return null
  }
}
