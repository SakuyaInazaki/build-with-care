import { parseConstraint, tokenize } from './judge.js'
import type { ActionInput, ConfirmedSpec, DecisionMatch, DecisionMatchOutcome, StructuredConstraint, StructuredDecision, Verdict, VerdictKind, WorkUnitInput } from './types.js'

export const DOMAIN_MEMBERS: Record<string, string[]> = {
  storage: ['postgres', 'sqlite', 'mysql', 'mongodb'],
  cache: ['redis', 'memory-cache', 'localstorage'],
  'frontend-framework': ['react', 'vue', 'svelte', 'angular'],
  language: ['python', 'javascript', 'typescript'],
  auth: ['jwt', 'session', 'oauth'],
}

const CHOICE_ALIASES: Record<string, string> = {
  postgresql: 'postgres', pgsql: 'postgres', pg: 'postgres', sqlite3: 'sqlite', mariadb: 'mysql', mongo: 'mongodb',
  memory: 'memory-cache', 'in-memory': 'memory-cache', 'local-storage': 'localstorage', oauth2: 'oauth',
  ts: 'typescript', js: 'javascript', py: 'python', reactjs: 'react', vuejs: 'vue',
}
const DOMAIN_ALIASES: Record<string, string> = {
  database: 'storage', db: 'storage', persistence: 'storage', datastore: 'storage', 数据库: 'storage', 存储: 'storage',
  caching: 'cache', 缓存: 'cache', frontend: 'frontend-framework', framework: 'frontend-framework', 前端: 'frontend-framework',
  lang: 'language', 语言: 'language', authentication: 'auth', login: 'auth', 鉴权: 'auth', 认证: 'auth', 登录: 'auth',
}
const PREFER_MARKER = /(优先|倾向|建议|尽量|prefer|preferably|ideally)/i
const slug = (value: unknown): string => String(value ?? '').trim().toLowerCase().replace(/^['"「」『』]+|['"「」『』]+$/g, '').replace(/\s+/g, '-')
export const normalizeChoice = (value: unknown): string => CHOICE_ALIASES[slug(value)] ?? slug(value)
export const normalizeDomain = (value: unknown): string => (DOMAIN_ALIASES[slug(value)] ?? slug(value)) || 'other'
export const domainOfChoice = (choice: string): string | undefined => Object.keys(DOMAIN_MEMBERS).find((domain) => DOMAIN_MEMBERS[domain]!.includes(choice))

export function normalizeDecision(value: unknown): StructuredDecision | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const choice = normalizeChoice(raw.choice ?? raw.value ?? raw.selection)
  if (!choice) return undefined
  const decision = { domain: normalizeDomain(raw.domain ?? raw.topic ?? raw.area), choice } as StructuredDecision
  if (decision.domain === 'other') decision.domain = domainOfChoice(choice) ?? 'other'
  decision.choice = choice
  if (typeof raw.rationale === 'string') decision.rationale = raw.rationale
  if (raw.specifiedByHuman === true || raw.specified_by_human === true) decision.specifiedByHuman = true
  if (raw.extracted === true) decision.extracted = true
  return decision
}

export function extractDecisions(action: ActionInput): StructuredDecision[] {
  const terms = tokenize(`${action.description} ${JSON.stringify(action.args)}`).map(normalizeChoice)
  return [...new Set(terms)].filter((choice) => domainOfChoice(choice)).map((choice) => ({ domain: domainOfChoice(choice)!, choice, extracted: true }))
}

export function structureConstraint(text: string, options: { id: string; source: StructuredConstraint['source']; domainHint?: string; forbidChoice?: string; affectsFromTurn?: number }): StructuredConstraint[] {
  const parsed = parseConstraint(text)
  const result: StructuredConstraint[] = []
  const add = (kind: StructuredConstraint['kind'], raw: string): void => {
    const value = normalizeChoice(raw)
    if (!value) return
    const domain = (options.domainHint && domainOfChoice(value) === options.domainHint) ? options.domainHint : domainOfChoice(value) ?? options.domainHint ?? 'other'
    const existing = result.find((item) => item.domain === domain && item.kind === kind)
    if (existing) existing.values.push(value)
    else result.push({ id: result.length ? `${options.id}-${result.length + 1}` : options.id, domain, kind, values: [value], text, source: options.source, createdAt: new Date().toISOString(), ...(options.affectsFromTurn === undefined ? {} : { affectsFromTurn: options.affectsFromTurn }) })
  }
  for (const value of parsed.forbidden) add('forbid', value)
  if (!parsed.forbidden.length && PREFER_MARKER.test(text)) for (const value of parsed.required) add('prefer', value)
  else for (const value of parsed.required) add('require', value)
  if (!result.length && options.forbidChoice) add('forbid', options.forbidChoice)
  return result
}

export function structureSpecConstraints(spec: ConfirmedSpec): StructuredConstraint[] {
  if (spec.structuredConstraints?.length) return spec.structuredConstraints.map((item) => ({ ...item, values: [...item.values] }))
  return spec.constraints.flatMap((text, index) => structureConstraint(text, { id: `spec-${index + 1}`, source: 'spec' }))
}

export function matchDecisions(decisions: readonly StructuredDecision[], constraints: readonly StructuredConstraint[], context: { request?: string; constraintTexts?: readonly string[]; turn?: number } = {}): DecisionMatch[] {
  const active = constraints.filter((item) => context.turn === undefined || item.affectsFromTurn === undefined || context.turn > item.affectsFromTurn)
  return decisions.map((raw) => {
    const decision = { ...raw, domain: normalizeDomain(raw.domain), choice: normalizeChoice(raw.choice) }
    const sameDomain = active.filter((item) => normalizeDomain(item.domain) === decision.domain)
    const related = sameDomain.length ? sameDomain : active.filter((item) => item.values.map(normalizeChoice).includes(decision.choice))
    const has = (item: StructuredConstraint) => item.values.map(normalizeChoice).includes(decision.choice)
    const forbid = related.find((item) => item.kind === 'forbid' && has(item))
    if (forbid) return match(decision, forbid.id, 'forbidden', `${decision.domain}：约束「${forbid.text}」禁止 ${decision.choice}，agent 却选了它`)
    const requires = related.filter((item) => item.kind === 'require')
    if (requires.length && !requires.some(has)) return match(decision, requires[0]!.id, 'required-mismatch', `${decision.domain}：约束要求 ${requires.flatMap((item) => item.values).join(' / ')}，agent 选了 ${decision.choice}`)
    const required = requires.find(has)
    if (required) return match(decision, required.id, 'required-match', `${decision.domain}：${decision.choice} 符合约束「${required.text}」`)
    if (decision.specifiedByHuman && [context.request ?? '', ...(context.constraintTexts ?? [])].some((text) => text.toLowerCase().includes(decision.choice))) return match(decision, undefined, 'human-specified', `${decision.domain}：${decision.choice} 是人在需求或约束中指定的`)
    const prefer = related.find((item) => item.kind === 'prefer' && !has(item))
    if (prefer) return match(decision, prefer.id, 'preference-mismatch', `${decision.domain}：偏离偏好「${prefer.text}」，agent 选了 ${decision.choice}`)
    return match(decision, undefined, 'unconstrained', `${decision.domain}：spec 未指定，agent 自主选择了 ${decision.choice}`)
  })
}
function match(decision: StructuredDecision, constraintId: string | undefined, outcome: DecisionMatchOutcome, explanation: string): DecisionMatch { return { decision, ...(constraintId ? { constraintId } : {}), outcome, explanation } }

const severity: Record<DecisionMatchOutcome, number> = { forbidden: 2, 'required-mismatch': 2, 'preference-mismatch': 1, unconstrained: 1, 'required-match': 0, 'human-specified': 0 }
export function verdictForUnit(unit: WorkUnitInput, matches: DecisionMatch[], constraints: readonly StructuredConstraint[]): Verdict {
  const worst = matches.length ? Math.max(...matches.map((item) => severity[item.outcome])) : unit.toolCalls.some((item) => item.kind === 'write' || item.kind === 'command') ? 1 : 0
  const kind: VerdictKind = worst === 2 ? 'red' : worst === 1 ? 'blue' : 'gray'
  return { kind, explanation: matches.length ? matches.map((item) => item.explanation).join('；') : kind === 'blue' ? '单元做了写入/命令但没有申报决策。' : '纯读取 / 验证单元。', alternatives: kind === 'red' ? [...new Set(constraints.filter((item) => item.kind === 'require').flatMap((item) => item.values).map((value) => `改用 ${value}`))].slice(0, 2) : [], ...(kind === 'red' ? { failureKind: 'constraint-conflict' as const } : {}) }
}

export function isConstraintConflict(outcome: DecisionMatchOutcome): boolean { return outcome === 'forbidden' || outcome === 'required-mismatch' }
