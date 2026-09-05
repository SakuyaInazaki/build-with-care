// The ledger: one row per work unit — "人说了什么" / "Agent 实际做了什么".
import { el, reconcile, rememberOpen, restoreOpen, fmtTime, argsSummary, json, emptyState, truncate } from './dom.js'
import {
  cardTone, stateLabel, isPendingRed, isHelp, humanContextOf, provenanceOf, assessmentOf, executorOutputOf,
  eventsForCard, injectedConstraints, TONE_GLYPH, TONE_LABEL, EVENT_LABEL, SOURCE_LABEL,
  unitOf, cardTitle, chipsOf, toolCallsOf, OUTCOME_LABEL, CALL_STATUS,
} from './model.js'
import { describePostHoc } from './adjudicate.js'

/**
 * ctx: { session, config, currentCardId, laneColor(agentId), busyCardId,
 *        actions: { focusDock(card), openAdjudicator(card), verifyHuman(card), decide(card, decision) } }
 */
export function renderLedger(root, ctx) {
  const cards = ctx.session?.cards || []
  if (!cards.length) {
    root.replaceChildren(emptyState(ctx.session?.spec ? '等待 agent 的第一步' : '确认 spec 后开工',
      ctx.session?.spec ? '运行演示或真实模型后，每个工作单元都会在这里对账。' : '左侧写一句话需求，让 agent 扩写约束，确认后 agent 才能动。'))
    return
  }
  const ordered = [...cards].sort((a, b) => (a.turn - b.turn) || (a.step - b.step) || String(a.createdAt).localeCompare(String(b.createdAt)))
  reconcile(root, ordered, (c) => c.id,
    (card) => { const node = el('article', { class: 'row', dataset: { cardId: card.id } }); fill(node, card, ctx, true); return node },
    (node, card) => fill(node, card, ctx, false))
}

function signature(card, ctx) {
  let s = ''
  try { s = JSON.stringify(card) } catch { s = String(card.id) }
  return `${s}|${eventsForCard(ctx.session, card.id).length}|${ctx.busyCardId === card.id ? 'busy' : ''}`
}

function fill(node, card, ctx, fresh) {
  const tone = cardTone(card)
  const pending = isPendingRed(card)
  const sig = signature(card, ctx)
  node.className = `row tone-${tone}${pending ? ' is-pending' : ''}${ctx.currentCardId === card.id ? ' is-current' : ''}${card.state === 'cancelled' ? ' is-cancelled' : ''}`
  if (!fresh && node.dataset.sig === sig) return // unchanged: keep DOM (inputs, focus, open details)
  const open = fresh ? null : rememberOpen(node)
  node.dataset.sig = sig
  node.replaceChildren(el('div', { class: 'row-rail', 'aria-hidden': 'true' }), body(card, ctx, tone, pending))
  if (open) restoreOpen(node, open)
}

function body(card, ctx, tone, pending) {
  const session = ctx.session
  const human = humanContextOf(card, session)
  const prov = provenanceOf(card, session)
  const assess = assessmentOf(card, session)
  const injected = new Set(injectedConstraints(session).map((i) => i.text))
  const unit = unitOf(card)
  const chips = chipsOf(card)

  const head = el('header', { class: 'row-head' },
    el('span', { class: 'idx', text: `turn ${card.turn} · step ${card.step}` }),
    el('span', { class: 'agent-badge', style: { '--lane': ctx.laneColor(card.agentId) }, text: card.agentId || 'agent' }),
    card.branchId && card.branchId !== 'main' ? el('span', { class: 'badge', text: card.branchId }) : null,
    el('span', { class: 'spacer' }),
    el('span', { class: `pill ${tone}`, text: `${TONE_GLYPH[tone]} ${TONE_LABEL[tone]} · ${stateLabel(card)}` }),
    card.externalSideEffect ? el('span', { class: 'pill amber', text: '⚠ 不可逆副作用' }) : null,
    el('time', { class: 'meta', text: fmtTime(card.createdAt), datetime: card.createdAt || '' }))

  // 人说了什么
  const humanCol = el('div', { class: 'human-col' }, el('div', { class: 'col-title', text: '人说了什么' }))
  humanCol.append(el('p', { class: 'req', text: human.request || '（尚未提供人类指令）' }))
  const cons = human.constraints || []
  if (cons.length) {
    const shown = cons.slice(0, 4)
    humanCol.append(el('ul', { class: 'cons' },
      shown.map((c) => el('li', { class: injected.has(c) ? 'inj' : '', text: injected.has(c) ? `${c}（人后来补充）` : c })),
      cons.length > shown.length ? el('li', { text: `…还有 ${cons.length - shown.length} 条` }) : null))
  }
  if (human.lastAdjudication) humanCol.append(el('div', { class: 'adjud', text: `最近裁决：${human.lastAdjudication}` }))

  // Agent 实际做了什么
  const agentCol = el('div', { class: 'agent-col' }, el('div', { class: 'col-title', text: 'Agent 实际做了什么' }))
  agentCol.append(el('p', { class: 'act', text: cardTitle(card) }))
  if (chips.length) {
    agentCol.append(el('div', { class: 'dchips', role: 'list', 'aria-label': '这一单元拍的板' }, chips.map((chip) => el('span', {
      class: `dchip ${chip.tone}${chip.extracted ? ' extracted' : ''}`, role: 'listitem',
      title: `${chip.extracted ? '从工具调用推断 · ' : ''}${OUTCOME_LABEL[chip.outcome] || chip.outcome}${chip.explanation ? `：${chip.explanation}` : ''}`,
    }, el('span', { class: 'dom', text: chip.domain }), el('span', { class: 'sep', text: '·' }), el('span', { text: chip.choice }), el('span', { class: 'oc', text: `（${OUTCOME_LABEL[chip.outcome] || chip.outcome}）` })))))
  }
  if (unit?.summary) agentCol.append(el('p', { class: 'unit-summary', text: unit.summary }))
  const calls = toolCallsOf(card)
  const args = argsSummary(card.action?.args)
  agentCol.append(el('div', { class: 'act-meta', title: args, text: unit
    ? `${calls.length} 个工具调用${calls.length ? ' · ' + calls.map((c) => c.action?.tool || 'tool').join(', ') : ''}`
    : `${card.action?.tool || 'tool'} · ${card.action?.kind || ''}${args ? ` · ${args}` : ''}` }))
  agentCol.append(el('p', { class: 'why' }, el('b', { text: '判官：' }), card.verdict?.explanation || ''))
  const tags = el('div', { class: 'assess' }, el('span', { text: '记录员：' }))
  if (assess.selfDirected) tags.append(el('span', { class: 'tag self', text: '自作主张' }))
  if (assess.drift) tags.append(el('span', { class: 'tag drift', text: '偏离指令' }))
  if (!assess.selfDirected && !assess.drift) tags.append(el('span', { class: 'tag ok', text: '按指令' }))
  if (assess.note) tags.append(el('span', { text: assess.note }))
  agentCol.append(tags)
  if (card.postHocDecision) agentCol.append(el('div', { class: 'post-hoc', text: `人：${describePostHoc(card.postHocDecision)}` }))
  else if (card.appliedConstraint && card.state === 'overridden') agentCol.append(el('div', { class: 'post-hoc', text: `人：已纠偏 → ${card.appliedConstraint}` }))

  const cols = el('div', { class: 'row-cols' }, humanCol, agentCol)

  const foot = el('footer', { class: 'row-foot' })
  foot.append(el('span', { class: 'prov', text: `判官：${prov.judge} · 记录员：${prov.recorder}${prov.confidence != null ? ` · 置信度 ${prov.confidence.toFixed(2)}` : ''}${card.runtimeAttempts ? ` · 运行尝试 ${card.runtimeAttempts}` : ''}` }))
  foot.append(rowActions(card, ctx, pending))

  const details = el('details', { class: 'more', dataset: { section: 'more' } },
    el('summary', { text: unit ? `细节：${calls.length} 个工具调用 · 证据 · 事件（${eventsForCard(session, card.id).length}）` : `细节：tool call · 执行输出 · 证据 · 事件（${eventsForCard(session, card.id).length}）` }),
    detailBody(card, ctx))

  const parts = [head, cols]
  if (isHelp(card)) parts.push(helpBox(card, ctx))
  parts.push(foot, details)
  return el('div', { class: 'row-main' }, parts)
}

function rowActions(card, ctx, pending) {
  const wrap = el('div', { class: 'row-actions' })
  const busy = ctx.busyCardId === card.id
  if (pending) {
    wrap.append(el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: '去裁决 →', onClick: () => ctx.actions.focusDock(card) }))
    return wrap
  }
  if (card.state === 'cancelled' || card.state === 'interrupted' || isHelp(card)) return wrap
  if (!card.postHocDecision) {
    if (card.verdict?.kind === 'blue') wrap.append(el('button', { type: 'button', class: 'btn btn-ghost btn-sm', disabled: busy, text: '确认放过', onClick: () => ctx.actions.decide(card, { kind: 'allow' }) }))
    wrap.append(el('button', { type: 'button', class: `btn ${card.verdict?.kind === 'blue' ? 'btn-secondary' : 'btn-ghost'} btn-sm`, disabled: busy, text: '翻案', onClick: () => ctx.actions.openAdjudicator(card) }))
  }
  return wrap
}

function helpBox(card, ctx) {
  const busy = ctx.busyCardId === card.id
  const input = el('input', { class: 'input', type: 'text', placeholder: '改写指示：改用…', 'aria-label': '改写指示' })
  const submit = () => { const text = input.value.trim(); if (!text) { input.focus(); return } ctx.actions.decide(card, { kind: 'rewrite', text }) }
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } e.stopPropagation() })
  const done = Boolean(card.postHocDecision)
  return el('div', { class: 'help-box', role: 'alert' },
    el('span', { 'aria-hidden': 'true', text: '🆘' }),
    el('span', null, el('b', { text: `运行失败 ${card.runtimeAttempts || 3} 次，升级求助` }), ' · agent 自修不成，需要人给方向'),
    el('span', { class: 'spacer' }),
    done ? el('span', { class: 'post-hoc', text: describePostHoc(card.postHocDecision) })
      : el('div', { class: 'help-actions' }, input,
        el('button', { type: 'button', class: 'btn btn-secondary btn-sm', disabled: busy, text: '改写指示', onClick: submit }),
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm', disabled: busy, text: '确认跳过', onClick: () => ctx.actions.decide(card, { kind: 'allow' }) })))
}

const CALL_GLYPH = { 'not-started': '○', running: '◐', succeeded: '●', failed: '✕', skipped: '–', blocked: '⛔' }

function callList(card) {
  const calls = toolCallsOf(card)
  if (!calls.length) return el('div', { class: 'meta', text: '这一单元没有工具调用（纯决策单元）。' })
  return el('div', { class: 'calls' }, calls.map((call, i) => {
    const a = call.action || {}
    const node = el('div', { class: `call ${call.status || ''}` },
      el('span', { class: 'st', title: CALL_STATUS[call.status] || call.status, text: CALL_GLYPH[call.status] || '○' }),
      el('span', { class: 'desc', text: `${i + 1}. ${a.description || a.tool || 'tool'} · ${CALL_STATUS[call.status] || call.status}${call.attempts > 1 ? ` · 尝试 ${call.attempts} 次` : ''}` }),
      el('span', { class: 'm', text: `${a.tool || ''} · ${a.kind || ''}${argsSummary(a.args) ? ` · ${argsSummary(a.args)}` : ''}` }))
    if (call.safetyNet) node.append(el('div', { class: 'net', text: `⛔ 安全网拦截：${call.safetyNet.explanation || call.safetyNet.outcome}` }))
    if (call.result) {
      const out = call.result.ok ? (call.result.output === undefined ? '' : (typeof call.result.output === 'string' ? call.result.output : json(call.result.output))) : (call.result.error || '失败')
      if (out) node.append(el('pre', { class: 'out', text: truncate(out, 600) }))
    }
    if (call.evidence) node.append(el('div', { class: `ev-line ${call.evidence.passed ? 'ok' : 'bad'}`, text: `${call.evidence.passed ? '🟢' : '🔴'} 证据 · ${call.evidence.source} · ${call.evidence.kind} · ${call.evidence.detail || ''}` }))
    return node
  }))
}

function detailBody(card, ctx) {
  const session = ctx.session
  const unit = unitOf(card)
  const wrap = el('div', { class: 'more-body' })
  if (unit) {
    wrap.append(el('div', null, el('h4', { text: '工具调用（按序）' }), callList(card)))
  } else {
    wrap.append(el('div', null, el('h4', { text: 'tool call' }), el('pre', { text: json({ tool: card.action?.tool, kind: card.action?.kind, args: card.action?.args, specified: card.action?.specified }) })))
    const output = executorOutputOf(card, session)
    wrap.append(el('div', null, el('h4', { text: `执行 · ${card.executionStatus}${card.executionId ? ` · ${card.executionId}` : ''}` }),
      el('pre', { text: output === undefined ? (card.executionStatus === 'not-started' ? '尚未执行' : '（无输出）') : (typeof output === 'string' ? output : json(output)) })))
  }
  const ev = card.verification
  const evidence = ev
    ? el('div', { class: `evidence ${ev.source === 'executor' ? (ev.passed ? 'passed' : 'failed') : 'human'}` },
      el('span', { text: ev.source === 'executor' ? (ev.passed ? '🟢' : '🔴') : '📝' }),
      el('span', null, el('b', { text: `${ev.source === 'executor' ? '执行器证据' : ev.source === 'human' ? '人工复核（不转 green）' : '外部来源'} · ${ev.kind} · ${ev.passed ? '通过' : '未通过'}` }), el('div', { class: 'meta', text: ev.detail })))
    : el('div', { class: 'evidence' }, el('span', { text: '◌' }), el('span', null, el('b', { text: '未绑定证据' }), el('div', { class: 'meta', text: '只有执行器绑定的通过证据才会把这一步变绿。' })))
  const evidenceWrap = el('div', null, el('h4', { text: '证据' }), evidence)
  if (card.executionStatus === 'succeeded' && !card.verification) evidenceWrap.append(el('button', { type: 'button', class: 'btn btn-link btn-sm', text: '记录人工复核（不转 green）', onClick: () => ctx.actions.verifyHuman(card) }))
  wrap.append(evidenceWrap)
  const events = eventsForCard(session, card.id)
  wrap.append(el('div', null, el('h4', { text: `这一步的事件（${events.length}）` }),
    el('div', { class: 'ev' }, events.flatMap((e) => [el('span', { class: 'seq', text: `#${e.sequence}` }), el('span', { text: `${EVENT_LABEL[e.type] || e.type} · ${SOURCE_LABEL[e.source] || e.source} · ${truncate(e.message, 140)}` })]))))
  return wrap
}
