/**
 * LLM configuration for the three model roles of the decision stream:
 * - `agent`    — the worker model that drives the tool-calling loop (typically DeepSeek).
 * - `judge`    — the independent judge that colours each action (must be a different model family — "异源").
 * - `recorder` — the reconciliation recorder; defaults to the judge configuration field by field.
 *
 * Environment variables (prefix `DECISION_STREAM_`, role in `AGENT` / `JUDGE` / `RECORDER`):
 *   `<ROLE>_PROVIDER`   `openai` (any OpenAI-compatible chat/completions endpoint) | `anthropic` (Messages API)
 *   `<ROLE>_BASE_URL`   endpoint root; defaults per provider
 *   `<ROLE>_API_KEY`    required for the role to count as configured; never logged
 *   `<ROLE>_MODEL`      required
 *   `<ROLE>_TIMEOUT_MS` per-request timeout, default 60000
 *
 * A `.env` file in the repo root is read with a tiny parser (no dotenv dependency).
 * Process environment wins; `.env` only fills variables that are unset or empty.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type LlmProvider = 'openai' | 'anthropic'
export type LlmRole = 'agent' | 'judge' | 'recorder'

export interface LlmRoleConfig {
  role: LlmRole
  provider: LlmProvider
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
}

export interface LlmConfig { agent: LlmRoleConfig | null; judge: LlmRoleConfig | null; recorder: LlmRoleConfig | null }

export interface LlmRoleDescription { configured: boolean; provider: LlmProvider | null; model: string | null }
export interface LlmConfigDescription { agent: LlmRoleDescription; judge: LlmRoleDescription; recorder: LlmRoleDescription }

export const ENV_PREFIX = 'DECISION_STREAM_'
export const DEFAULT_TIMEOUT_MS = 60_000
export const DEFAULT_BASE_URL: Record<LlmProvider, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
}

type EnvSource = Record<string, string | undefined>

/** Parses `KEY=value` lines. Supports `export KEY=`, single/double quotes, `#` comments and blank lines. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    let value = match[2]!.trim()
    const quoted = value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    if (quoted) {
      const quote = value[0]
      value = value.slice(1, -1)
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"')
    } else {
      const comment = value.search(/\s#/)
      if (comment >= 0) value = value.slice(0, comment).trim()
    }
    out[match[1]!] = value
  }
  return out
}

/** Reads `<root>/.env` if it exists. Never throws; a missing or unreadable file yields `{}`. */
export function loadDotEnv(root: string = process.cwd()): Record<string, string> {
  const path = resolve(root, '.env')
  if (!existsSync(path)) return {}
  try { return parseDotEnv(readFileSync(path, 'utf8')) } catch { return {} }
}

export interface LoadLlmConfigOptions {
  /** Process environment to read (default `process.env`). */
  env?: EnvSource
  /** Pre-parsed `.env` values, or `false` to skip the file entirely. Default: read `<root>/.env`. */
  dotenv?: Record<string, string> | false
  /** Directory containing `.env` (default `process.cwd()`). */
  root?: string
}

function normalizeProvider(value: string | undefined, baseUrl: string | undefined): LlmProvider {
  const lower = value?.trim().toLowerCase()
  if (lower === 'anthropic' || lower === 'claude' || lower === 'messages') return 'anthropic'
  if (lower === 'openai' || lower === 'openai-compatible' || lower === 'deepseek' || lower === 'chat-completions') return 'openai'
  if (!lower && baseUrl && /anthropic/i.test(baseUrl)) return 'anthropic'
  return 'openai'
}

function normalizeBaseUrl(value: string | undefined, provider: LlmProvider): string {
  const trimmed = value?.trim().replace(/\/+$/, '')
  return trimmed || DEFAULT_BASE_URL[provider]
}

function normalizeTimeout(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS
}

interface RawRole { provider?: string; baseUrl?: string; apiKey?: string; model?: string; timeoutMs?: string }

function resolveRole(role: LlmRole, raw: RawRole): LlmRoleConfig | null {
  const model = raw.model?.trim()
  const apiKey = raw.apiKey?.trim()
  if (!model || !apiKey) return null
  const provider = normalizeProvider(raw.provider, raw.baseUrl)
  return { role, provider, baseUrl: normalizeBaseUrl(raw.baseUrl, provider), apiKey, model, timeoutMs: normalizeTimeout(raw.timeoutMs) }
}

/** Resolves the three role configurations from the environment (+ `.env`). Roles without key+model resolve to `null`. */
export function loadLlmConfig(options: LoadLlmConfigOptions = {}): LlmConfig {
  const processEnv: EnvSource = options.env ?? process.env
  const fileEnv = options.dotenv === false ? {} : options.dotenv ?? loadDotEnv(options.root)
  const lookup = (key: string): string | undefined => {
    const fromProcess = processEnv[key]
    if (fromProcess !== undefined && fromProcess !== '') return fromProcess
    const fromFile = fileEnv[key]
    return fromFile !== undefined && fromFile !== '' ? fromFile : undefined
  }
  const read = (role: 'AGENT' | 'JUDGE' | 'RECORDER'): RawRole => ({
    provider: lookup(`${ENV_PREFIX}${role}_PROVIDER`),
    baseUrl: lookup(`${ENV_PREFIX}${role}_BASE_URL`),
    apiKey: lookup(`${ENV_PREFIX}${role}_API_KEY`),
    model: lookup(`${ENV_PREFIX}${role}_MODEL`),
    timeoutMs: lookup(`${ENV_PREFIX}${role}_TIMEOUT_MS`),
  })
  const agent = read('AGENT')
  const judge = read('JUDGE')
  const recorderRaw = read('RECORDER')
  // Recorder falls back to the judge field by field, so `RECORDER_MODEL` alone swaps the model on the judge's gateway.
  const recorder: RawRole = {
    provider: recorderRaw.provider ?? judge.provider,
    baseUrl: recorderRaw.baseUrl ?? judge.baseUrl,
    apiKey: recorderRaw.apiKey ?? judge.apiKey,
    model: recorderRaw.model ?? judge.model,
    timeoutMs: recorderRaw.timeoutMs ?? judge.timeoutMs,
  }
  return { agent: resolveRole('agent', agent), judge: resolveRole('judge', judge), recorder: resolveRole('recorder', recorder) }
}

function describeRole(config: LlmRoleConfig | null): LlmRoleDescription {
  return config ? { configured: true, provider: config.provider, model: config.model } : { configured: false, provider: null, model: null }
}

/** Key-free summary for `GET /api/config`. Safe to serialize and log. */
export function describeLlmConfig(config: LlmConfig = loadLlmConfig()): LlmConfigDescription {
  return { agent: describeRole(config.agent), judge: describeRole(config.judge), recorder: describeRole(config.recorder) }
}

/** Human-readable warnings about a configuration (e.g. judge and agent share a model, violating "异源"). Never includes keys. */
export function llmConfigWarnings(config: LlmConfig): string[] {
  const warnings: string[] = []
  if (config.agent && config.judge && config.agent.model === config.judge.model && config.agent.baseUrl === config.judge.baseUrl) {
    warnings.push(`判官与干活 agent 使用同一模型（${config.judge.model}），不满足"异源"要求；请给 JUDGE 配一个不同家族的模型。`)
  }
  if (config.judge && !config.agent) warnings.push('只配置了判官，没有配置干活 agent：真实 LLM agent 不可用，demo 仍可用。')
  if (config.agent && !config.judge) warnings.push('只配置了干活 agent，没有配置判官：判色将使用规则判官（deterministic）。')
  return warnings
}
