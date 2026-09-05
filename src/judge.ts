import type { ActionInput, ConfirmedSpec, RecordingAssessment, RecorderInput, Verdict } from './types.js'

export interface JudgeInput { spec: ConfirmedSpec; action: ActionInput }
/** Decision judging and provenance recording are separate replacement seams. `name` ends up in `card.provenance`. */
export interface DecisionJudge { readonly name?: string; judge(input: JudgeInput): Verdict | Promise<Verdict> }
export interface DecisionRecorder { readonly name?: string; assess(input: RecorderInput): RecordingAssessment | Promise<RecordingAssessment> }

// ---------------------------------------------------------------------------
// Constraint parsing (rule-based, no model)
// ---------------------------------------------------------------------------

/** Small, readable table: canonical technology name -> aliases seen in prose/args. */
const TECH_ALIASES: Record<string, string[]> = {
  postgres: ['postgresql', 'pgsql'],
  sqlite: ['sqlite3'],
  mysql: ['mariadb'],
  mongodb: ['mongo'],
  redis: [],
  'memory-cache': ['memory', '内存缓存', '内存'],
  localstorage: ['local-storage'],
  react: [],
  vue: [],
  svelte: [],
  angular: [],
  python: [],
  javascript: [],
  typescript: [],
  jwt: [],
  session: [],
  oauth: ['oauth2'],
}

/** Members of one group compete with each other: requiring one forbids picking another. */
const COMPETITOR_GROUPS: string[][] = [
  ['postgres', 'sqlite', 'mysql', 'mongodb'],
  ['redis', 'memory-cache', 'localstorage'],
  ['react', 'vue', 'svelte', 'angular'],
  ['python', 'javascript', 'typescript'],
  ['jwt', 'session', 'oauth'],
]

const FORBID_MARKER = /(不允许|不得|不能|不要|不用|不可|禁止|禁用|避免|别用|勿|must not|mustn't|do not|don't|never|avoid|\bno\b|\bnot\b)/i
const REQUIRE_MARKER = /(必须|只能|只用|只允许|统一|须|应当|应该|要求|采用|使用|\bmust\b|\bonly\b|\bshould\b|\buse\b|\brequires?\b)/i
const CLAUSE_SPLIT = /[，,；;。.!！?？\n]|以及|并且|同时|\band\b/i

/** Words that carry no technical meaning; longest first so substrings are stripped correctly from CJK runs. */
const CJK_STOPWORDS = [
  '不允许', '只允许', '由人确认', '人工确认',
  '不能', '不得', '不要', '不用', '不可', '禁止', '禁用', '避免', '别用',
  '必须', '只能', '只用', '统一', '应当', '应该', '要求', '采用', '使用', '选择', '选用', '需要',
  '后续', '之后', '以后', '存储', '方案', '实现', '方式', '方法', '进行', '作为', '所有', '全部', '一律',
  '须', '用', '做', '的', '了', '要', '别', '勿', '请', '把', '将', '并', '也', '都', '就', '再', '及',
].sort((a, b) => b.length - a.length)

const LATIN_STOPWORDS = new Set([
  'must', 'not', 'do', 'never', 'no', 'only', 'use', 'should', 'the', 'a', 'an', 'be', 'to', 'of', 'and', 'or',
  'for', 'with', 'is', 'are', 'it', 'in', 'on', 'by', 'at', 'as', 'this', 'that', 'any', 'all', 'via', 'requires', 'require',
  'true', 'false', 'null', 'path', 'content', 'target', 'command', 'provider',
])

const isCjk = (value: string): boolean => /^\p{Script=Han}+$/u.test(value)

function canonical(term: string): string {
  for (const [name, aliases] of Object.entries(TECH_ALIASES)) {
    if (term === name || aliases.includes(term)) return name
  }
  return term
}

function competitorsOf(term: string): string[] {
  const group = COMPETITOR_GROUPS.find((members) => members.includes(term))
  return group ? group.filter((member) => member !== term) : []
}

/** Split text into technical terms: CJK runs (stopwords stripped) and Latin words of 2+ chars. */
export function tokenize(text: string): string[] {
  const runs = text.toLowerCase().match(/\p{Script=Han}+|[a-z0-9][a-z0-9_+#-]*/gu) ?? []
  const terms = new Set<string>()
  for (const run of runs) {
    if (isCjk(run)) {
      let stripped = run
      for (const word of CJK_STOPWORDS) stripped = stripped.split(word).join(' ')
      for (const piece of stripped.split(' ')) if (piece.length >= 2) terms.add(canonical(piece))
      continue
    }
    if (run.length < 2 || LATIN_STOPWORDS.has(run)) continue
    terms.add(canonical(run))
  }
  return [...terms]
}

export interface ParsedConstraint { text: string; forbidden: string[]; required: string[] }

/** Each clause of a constraint either forbids its terms or requires them; other clauses are ignored. */
export function parseConstraint(text: string): ParsedConstraint {
  const forbidden = new Set<string>()
  const required = new Set<string>()
  for (const clause of text.split(CLAUSE_SPLIT)) {
    const trimmed = clause.trim()
    if (!trimmed) continue
    const terms = tokenize(trimmed)
    if (FORBID_MARKER.test(trimmed)) for (const term of terms) forbidden.add(term)
    else if (REQUIRE_MARKER.test(trimmed)) for (const term of terms) required.add(term)
  }
  return { text, forbidden: [...forbidden], required: [...required] }
}

const actionText = (action: ActionInput): string => `${action.description} ${JSON.stringify(action.args)}`

function mentions(text: string, terms: string[], term: string): boolean {
  if (isCjk(term)) return text.toLowerCase().includes(term)
  return terms.includes(term)
}

interface Conflict { constraint: ParsedConstraint; term: string; required?: string; strength: 'forbidden' | 'competitor' }

/** First rule that fires wins: an explicitly forbidden term beats a competitor of a required term. */
export function findConflict(constraints: string[], action: ActionInput): Conflict | undefined {
  const text = actionText(action)
  const terms = tokenize(text)
  const parsed = constraints.map(parseConstraint)
  for (const constraint of parsed) {
    const hit = constraint.forbidden.find((term) => mentions(text, terms, term))
    if (hit) return { constraint, term: hit, required: requiredAlternative(parsed, hit), strength: 'forbidden' }
  }
  for (const constraint of parsed) {
    for (const required of constraint.required) {
      const hit = competitorsOf(required).find((term) => mentions(text, terms, term))
      if (hit) return { constraint, term: hit, required, strength: 'competitor' }
    }
  }
  return undefined
}

function requiredAlternative(parsed: ParsedConstraint[], forbiddenTerm: string): string | undefined {
  const competitors = competitorsOf(forbiddenTerm)
  for (const constraint of parsed) {
    const match = constraint.required.find((term) => competitors.includes(term))
    if (match) return match
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------

export class DeterministicJudge implements DecisionJudge {
  readonly name = 'deterministic'

  judge({ spec, action }: JudgeInput): Verdict {
    const conflict = findConflict(spec.constraints, action)
    if (conflict) {
      const explanation = conflict.strength === 'forbidden'
        ? `动作提到了「${conflict.term}」，而已确认约束「${conflict.constraint.text}」禁止它，请先裁决。`
        : `动作选择了「${conflict.term}」，与约束「${conflict.constraint.text}」要求的「${conflict.required}」冲突，请先裁决。`
      const alternatives = [
        conflict.required ? `改用 ${conflict.required}` : '按已确认 spec 执行',
        '选择不同实现',
        '叫停当前任务',
      ]
      return { kind: 'red', explanation, alternatives, failureKind: 'constraint-conflict' }
    }
    if (action.kind === 'read' || action.kind === 'validate') {
      return { kind: 'gray', explanation: '纯读取或验证动作，不产生需要拍板的决策。', alternatives: [] }
    }
    return { kind: 'blue', explanation: `spec 未指定「${action.description}」的具体方案，agent 自主选择了当前方案。`, alternatives: blueAlternatives(action) }
  }
}

function blueAlternatives(action: ActionInput): string[] {
  const terms = tokenize(actionText(action))
  const chosen = terms.find((term) => competitorsOf(term).length > 0)
  if (!chosen) return ['保留当前选择', '改用更保守的实现', '补充一条后续约束']
  return [`保留当前选择（${chosen}）`, ...competitorsOf(chosen).slice(0, 2).map((term) => `改用 ${term}`), '补充一条后续约束']
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

export class DeterministicRecorder implements DecisionRecorder {
  readonly name = 'deterministic'

  assess({ action, humanInstruction, constraints, lastAdjudication }: RecorderInput): RecordingAssessment {
    const selfDirected = action.specified !== true
    const sources = [lastAdjudication, humanInstruction, ...(constraints ?? [])].filter((value): value is string => Boolean(value))
    const conflict = findConflict(sources, action)
    if (conflict) {
      const origin = conflict.constraint.text === lastAdjudication ? '最近一次人的裁决' : '已确认约束'
      const confidence = conflict.strength === 'forbidden' ? 0.95 : 0.85
      return {
        selfDirected,
        deviatesFromInstruction: true,
        drift: true,
        confidence,
        note: `记录偏差：动作提到「${conflict.term}」，与${origin}「${conflict.constraint.text}」不符。`,
      }
    }
    if (!selfDirected) {
      return { selfDirected, deviatesFromInstruction: false, drift: false, confidence: 0.6, note: '动作来自人的明确指令，按指令记录。' }
    }
    return { selfDirected, deviatesFromInstruction: false, drift: false, confidence: 0.7, note: '人未指定此处方案，agent 自主选择；已记录，未阻断执行。' }
  }
}
