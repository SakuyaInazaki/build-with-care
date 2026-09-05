// Pure helpers over SessionState / DecisionCard / TimelineEvent (contract v2, tolerant of v1).

export const LANES = ['var(--lane-1)', 'var(--lane-2)', 'var(--lane-3)', 'var(--lane-4)', 'var(--lane-5)']
export const HUMAN_TYPES = new Set(['human-command', 'human-adjudication', 'injection', 'fork', 'branch-created', 'cancel'])

export const TONE_LABEL = { red: '红', blue: '蓝', gray: '灰', green: '绿', failed: '失败' }
export const TONE_GLYPH = { red: '🔴', blue: '🔵', gray: '⚪', green: '🟢', failed: '🆘' }
export const TONE_COLOR = { red: 'var(--red-500)', blue: 'var(--blue-500)', gray: 'var(--g-400)', green: 'var(--green-500)', failed: 'var(--amber-500)' }

export const STATE_LABEL = {
  pending: '等待裁决', allowed: '已执行', overridden: '已纠偏', cancelled: '已叫停',
  interrupted: '重启中断', verified: '已验证', failed: '运行失败',
}
export const EVENT_LABEL = {
  'session-start': '会话开始', 'session-end': '会话结束', 'agent-registered': 'agent 接入', 'turn-start': 'turn 开始', 'step-start': 'step 开始',
  'human-command': '人的指令', 'agent-action': 'agent 动作', 'card-created': '生成卡片', verdict: '判官判色',
  'human-adjudication': '人的裁决', injection: '注入约束', 'tool-result': '执行结果', verification: '验证证据', failure: '失败',
  'branch-created': '创建分支', fork: 'fork', cancel: '叫停', 'turn-end': 'turn 结束', 'adapter-event': '外部事件', runner: 'runner', 'tool-call': '工具调用',
}
export const SOURCE_LABEL = { stream: '流', judge: '判官', recorder: '记录员', executor: '执行器', human: '人', workspace: '工作区', runner: 'runner', agent: 'agent' }

export const cardTone = (card) => {
  if (!card) return 'gray'
  if (card.state === 'verified') return 'green'
  if (card.state === 'failed' || card.blockedHelp) return 'failed'
  return card.verdict?.kind || 'gray'
}
export const isPendingRed = (card) => card.state === 'pending'
export const isExecuted = (card) => card.state !== 'pending'
export const isHelp = (card) => Boolean(card.blockedHelp) || (card.state === 'failed' && card.failureKind === 'runtime-error')

export function stateLabel(card) {
  if (isHelp(card)) return `运行失败 ${card.runtimeAttempts || 3} 次，求助`
  if (card.state === 'allowed' && card.verificationStatus !== 'passed') return '已执行 · 待验证'
  return STATE_LABEL[card.state] || card.state
}

export function agentsOf(session) {
  const seen = []
  const push = (id) => { if (id && !seen.includes(id)) seen.push(id) }
  for (const id of session?.agents || []) push(id)
  for (const ev of session?.timeline || []) push(ev.agentId)
  for (const card of session?.cards || []) push(card.agentId)
  return seen
}

export function laneColorFor(session) {
  const agents = agentsOf(session)
  return (agentId) => { const i = agents.indexOf(agentId); return i < 0 ? 'var(--g-400)' : LANES[i % LANES.length] }
}

export const pendingCards = (session) => (session?.cards || []).filter(isPendingRed)
export const blueCards = (session) => (session?.cards || []).filter((c) => c.verdict?.kind === 'blue')
export const cardById = (session, id) => (session?.cards || []).find((c) => c.id === id)
export const eventsForCard = (session, cardId) => (session?.timeline || []).filter((e) => e.cardId === cardId)

export function originalConstraints(session) {
  const ev = (session?.timeline || []).find((e) => e.type === 'human-command' && e.metadata?.spec?.constraints)
  return ev ? [...ev.metadata.spec.constraints] : (session?.spec?.constraints || [])
}
export function injectedConstraints(session) {
  const list = []
  for (const ev of session?.timeline || []) {
    const text = ev.type === 'injection' ? ev.metadata?.constraint : null
    if (typeof text === 'string' && text && !list.some((i) => i.text === text)) list.push({ text, at: ev.at, sequence: ev.sequence, cardId: ev.cardId })
  }
  return list
}

export function humanContextOf(card, session) {
  if (card.humanContext) return card.humanContext
  const spec = session?.spec
  return { request: spec?.request || '', constraints: spec?.constraints || [], lastAdjudication: card.appliedConstraint }
}

export function provenanceOf(card, session) {
  const created = (session?.timeline || []).find((e) => e.type === 'card-created' && e.cardId === card.id)
  const confidence = card.assessment?.confidence ?? created?.metadata?.confidence
  return {
    judge: card.provenance?.judge || 'deterministic',
    recorder: card.provenance?.recorder || 'deterministic',
    confidence: typeof confidence === 'number' ? confidence : null,
  }
}

export function assessmentOf(card, session) {
  if (card.assessment) return card.assessment
  const created = (session?.timeline || []).find((e) => e.type === 'card-created' && e.cardId === card.id)
  const m = created?.metadata || {}
  return { selfDirected: Boolean(m.selfDirected), drift: Boolean(m.drift), confidence: typeof m.confidence === 'number' ? m.confidence : 0, note: card.failureKind === 'recording-drift' ? '动作与人类指令存在记录偏差' : '' }
}

export function executorOutputOf(card, session) {
  const ev = [...(session?.timeline || [])].reverse().find((e) => e.type === 'tool-result' && e.cardId === card.id)
  return ev?.metadata?.output
}

export function deadlineOf(card, config) {
  if (card.approvalDeadline) return new Date(card.approvalDeadline).getTime()
  const timeout = config?.approvalTimeoutMs
  if (typeof timeout === 'number' && card.createdAt) return new Date(card.createdAt).getTime() + timeout
  return null
}

/** Category + colour for a timeline event tick / row. */
export function eventKind(event, session) {
  const type = event.type
  if (HUMAN_TYPES.has(type)) return { cat: 'human', color: 'var(--teal-500)', shape: 'diamond' }
  if (type === 'card-created' || type === 'verdict') {
    const kind = event.metadata?.card?.verdict?.kind || cardById(session, event.cardId)?.verdict?.kind || 'gray'
    return { cat: kind, color: TONE_COLOR[kind] || TONE_COLOR.gray, shape: 'circle' }
  }
  if (type === 'verification') { const ok = event.metadata?.controlled && event.metadata?.evidence?.passed; return { cat: ok ? 'green' : 'gray', color: ok ? TONE_COLOR.green : 'var(--amber-500)', shape: 'circle' } }
  if (type === 'failure') return { cat: 'failure', color: 'var(--amber-500)', shape: 'square' }
  if (type === 'tool-result') return { cat: 'exec', color: 'var(--g-500)', shape: 'circle' }
  if (type === 'runner' || type === 'session-start' || type === 'session-end') return { cat: 'system', color: 'var(--g-700)', shape: 'circle' }
  return { cat: 'system', color: 'var(--g-300)', shape: 'circle' }
}

export const modeLabel = (mode) => (mode === 'rewind-and-fork' ? 'rewind-and-fork' : 'forward-only')

/** Report fields with client-side fallbacks for v1 backends. */
export function reportOf(session) {
  const r = session?.report || {}
  const cards = session?.cards || []
  const timeline = session?.timeline || []
  const byColor = r.byColor || cards.reduce((acc, c) => { acc[cardTone(c)] = (acc[cardTone(c)] || 0) + 1; return acc }, { red: 0, blue: 0, gray: 0, green: 0, failed: 0 })
  const perAgent = r.perAgent || agentsOf(session).map((agentId) => {
    const mine = cards.filter((c) => c.agentId === agentId)
    return {
      agentId, actions: mine.length,
      selfDirected: mine.filter((c) => assessmentOf(c, session).selfDirected).length,
      red: mine.filter((c) => c.verdict?.kind === 'red').length, blue: mine.filter((c) => c.verdict?.kind === 'blue').length,
      gray: mine.filter((c) => c.verdict?.kind === 'gray').length, verified: mine.filter((c) => c.state === 'verified').length,
      failed: mine.filter((c) => c.state === 'failed').length,
    }
  })
  const adjudications = timeline.filter((e) => e.type === 'human-adjudication')
  const humanDecisions = r.humanDecisions ?? (timeline.filter((e) => e.type === 'human-command').length + adjudications.length + timeline.filter((e) => e.type === 'cancel' && e.source === 'human').length)
  const agentDecisions = r.agentDecisions ?? (r.selfDirected ?? cards.filter((c) => assessmentOf(c, session).selfDirected).length)
  const directionCorrections = r.directionCorrections ?? adjudications.filter((e) => { const k = e.metadata?.decision?.kind; const card = cardById(session, e.cardId); return (k === 'alternative' || k === 'rewrite') && card?.verdict?.kind === 'red' }).length
  const corrections = (r.corrections || []).map((c) => {
    const card = cardById(session, c.cardId)
    return { turn: card?.turn, agentId: card?.agentId, kind: c.kind, postHoc: false, at: c.at, ...c }
  })
  const started = r.startedAt || timeline[0]?.at || session?.createdAt
  const ended = r.endedAt || session?.endedAt
  const durationMs = r.durationMs ?? (started ? (ended ? new Date(ended) : new Date()) - new Date(started) : null)
  return {
    ...r, byColor, perAgent, humanDecisions, agentDecisions, directionCorrections, corrections, startedAt: started, endedAt: ended, durationMs,
    decisions: r.decisions ?? cards.filter((c) => c.verdict?.kind !== 'gray').length,
    allowed: r.allowed ?? 0, overrides: r.overrides ?? 0, cancelled: r.cancelled ?? 0,
    verificationEvidence: r.verificationEvidence ?? cards.filter((c) => c.verification?.source === 'executor').length,
    unverified: r.unverified ?? cards.filter((c) => c.executionStatus === 'succeeded' && c.verificationStatus !== 'passed').length,
    runtimeFailures: r.runtimeFailures ?? 0, blockedHelp: r.blockedHelp ?? 0, irreversibleSideEffects: r.irreversibleSideEffects ?? 0,
    branches: r.branches ?? (session?.branches || []).length,
    summary: r.summary || '',
  }
}

// ---------- work units (contract appendix §4) ----------
export const OUTCOME_TONE = { forbidden: 'red', 'required-mismatch': 'red', 'preference-mismatch': 'blue', unconstrained: 'blue', 'required-match': 'gray', 'human-specified': 'gray' }
export const OUTCOME_LABEL = { forbidden: '被禁止', 'required-mismatch': '与要求不符', 'preference-mismatch': '偏离偏好', unconstrained: '自主拍板', 'required-match': '符合要求', 'human-specified': '人指定' }
export const KIND_LABEL = { require: '必须', forbid: '禁止', prefer: '偏好' }
export const CALL_STATUS = { 'not-started': '未开始', running: '运行中', succeeded: '成功', failed: '失败', skipped: '跳过', blocked: '安全网拦截' }

export const unitOf = (card) => (card && card.unit && typeof card.unit === 'object' ? card.unit : null)
export const cardTitle = (card) => unitOf(card)?.goal || card?.action?.description || '（无描述）'

/** Decision chips: unit.decisions joined with unit.matches (by domain+choice). */
export function chipsOf(card) {
  const unit = unitOf(card)
  if (!unit) return []
  const matches = unit.matches || card.verdict?.matches || []
  return (unit.decisions || []).map((d) => {
    const m = matches.find((x) => x.decision && x.decision.domain === d.domain && x.decision.choice === d.choice) || matches.find((x) => x.decision?.domain === d.domain)
    const outcome = m?.outcome || (d.specifiedByHuman ? 'human-specified' : 'unconstrained')
    return { domain: d.domain, choice: d.choice, outcome, tone: OUTCOME_TONE[outcome] || 'blue', explanation: m?.explanation || d.rationale || '', extracted: Boolean(d.extracted), rationale: d.rationale || '' }
  })
}

/** Red-card copy: explanations of the red matches (falls back to verdict.explanation). */
export function redExplanations(card) {
  const unit = unitOf(card)
  const matches = unit?.matches || card.verdict?.matches || []
  const red = matches.filter((m) => OUTCOME_TONE[m.outcome] === 'red').map((m) => m.explanation).filter(Boolean)
  const net = (unit?.toolCalls || []).filter((c) => c.safetyNet).map((c) => `安全网：${c.safetyNet.explanation}`)
  const all = [...red, ...net]
  return all.length ? all : [card.verdict?.explanation || ''].filter(Boolean)
}

export const toolCallsOf = (card) => unitOf(card)?.toolCalls || []

/** Structured constraints for the spec panel (with legacy fallback to plain text). */
export function structuredConstraintsOf(session) {
  const list = session?.spec?.structuredConstraints
  return Array.isArray(list) ? list : null
}
