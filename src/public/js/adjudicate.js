// Shared adjudication controls: used by the red-card dock (pending) and the post-hoc dialog (executed cards).
import { el, fmtCountdown } from './dom.js'
import { deadlineOf, humanContextOf, TONE_GLYPH, cardTone, cardTitle, chipsOf, redExplanations } from './model.js'

const KEYS = ['1', '2', '3']

/**
 * opts: { postHoc, busy, onDecide(decision), laneColor(agentId), session, config, showAgent }
 * Returns { root, tick() } — tick updates the countdown (pending cards only).
 */
export function buildAdjudicator(card, opts) {
  const { postHoc = false, busy = false, onDecide, laneColor, session, config } = opts
  const root = el('div', { class: `adjudicator${busy ? ' dock-busy' : ''}` })
  const human = humanContextOf(card, session)

  root.append(el('div', { class: 'dock-agent' },
    el('span', { class: 'agent-badge', style: { '--lane': laneColor ? laneColor(card.agentId) : '' }, text: card.agentId || 'agent' }),
    el('span', { text: `turn ${card.turn} · step ${card.step}` }),
    el('span', { text: `${TONE_GLYPH[cardTone(card)]} ${postHoc ? '事后翻案' : '执行前阻断'}` })))
  root.append(el('h3', { class: 'dock-action', id: postHoc ? 'adjudicatorTitle' : undefined, text: cardTitle(card) }))
  const chips = chipsOf(card)
  if (chips.length) root.append(el('div', { class: 'dchips' }, chips.map((chip) => el('span', { class: `dchip ${chip.tone}${chip.extracted ? ' extracted' : ''}`, title: chip.extracted ? '从工具调用推断' : (chip.explanation || '') }, el('span', { class: 'dom', text: chip.domain }), el('span', { class: 'sep', text: '·' }), el('span', { text: chip.choice })))))
  const reasons = cardTone(card) === 'red' ? redExplanations(card) : [card.verdict?.explanation || '']
  root.append(el('div', { class: 'dock-why' }, reasons.map((r, i) => el('p', null, i === 0 ? el('b', { text: '判官：' }) : null, r))))

  const conflict = findConflict(card, human)
  if (conflict) root.append(el('div', { class: 'dock-conflict', text: `冲突约束：${conflict}` }))
  if (postHoc && card.postHocDecision) root.append(el('div', { class: 'note', text: `已有翻案记录：${describePostHoc(card.postHocDecision)}` }))

  const alternatives = (card.verdict?.alternatives || []).slice(0, 3)
  if (alternatives.length) {
    root.append(el('div', { class: 'dock-label', text: postHoc ? '翻案方向（只影响后续步骤）' : '一键选择备选方向' }))
    root.append(el('div', { class: 'alts' }, alternatives.map((text, i) => el('button', {
      type: 'button', class: 'alt', disabled: busy,
      onClick: () => onDecide({ kind: 'alternative', text }),
    }, el('kbd', { text: KEYS[i] }), el('span', { text })))))
  }

  const input = el('input', { class: 'input', type: 'text', placeholder: postHoc ? '自由改写：后续必须…' : '自由改写：这里应该…', 'aria-label': '自由改写' })
  const apply = el('button', { type: 'button', class: 'btn btn-secondary', disabled: busy, text: '应用改写', onClick: () => submitRewrite() })
  const submitRewrite = () => { const text = input.value.trim(); if (!text) { input.focus(); return } onDecide({ kind: 'rewrite', text }) }
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitRewrite() } e.stopPropagation() })
  root.append(el('div', { class: 'rewrite' }, input, apply))

  const secondary = el('div', { class: 'dock-secondary' })
  secondary.append(el('button', { type: 'button', class: 'btn btn-secondary', disabled: busy, onClick: () => onDecide({ kind: 'allow' }) },
    postHoc ? null : el('kbd', { text: 'A' }), postHoc ? '确认放过' : '放行原动作'))
  if (!postHoc) secondary.append(el('button', { type: 'button', class: 'btn btn-ghost danger', disabled: busy, text: '叫停这张卡', onClick: () => onDecide({ kind: 'cancel' }) }))
  else secondary.append(el('span', { class: 'meta', text: '已执行的动作不能叫停，只能向前纠偏' }))
  root.append(secondary)

  let tick = () => {}
  if (!postHoc) {
    const deadline = deadlineOf(card, config)
    const total = deadline && card.createdAt ? Math.max(1, deadline - new Date(card.createdAt).getTime()) : null
    const box = el('div', { class: 'countdown' })
    const label = el('span')
    const bar = el('div', { class: 'bar' }, el('i'))
    box.append(label, bar)
    root.append(box)
    tick = () => {
      if (!deadline) { label.textContent = '超时未裁决将自动叫停（fail-closed）'; bar.hidden = true; return }
      const left = deadline - Date.now()
      label.textContent = left > 0 ? `${fmtCountdown(left)} 后自动叫停（fail-closed）` : '已超时，正在自动叫停…'
      bar.firstChild.style.width = total ? `${Math.max(0, Math.min(100, (left / total) * 100))}%` : '0%'
      box.classList.toggle('urgent', left < 60_000)
    }
    tick()
  }
  return { root, tick, alternatives, input }
}

export function describePostHoc(decision) {
  if (!decision) return ''
  if (decision.kind === 'allow') return '已确认放过'
  if (decision.kind === 'alternative') return `已翻案（只影响后续）：${decision.text || ''}`
  if (decision.kind === 'rewrite') return `已改写（只影响后续）：${decision.text || ''}`
  return decision.kind
}

function findConflict(card, human) {
  const explanation = card.verdict?.explanation || ''
  const quoted = explanation.match(/[“"]([^”"]{2,})[”"]/)
  if (quoted) return quoted[1]
  const text = `${card.action?.description || ''} ${JSON.stringify(card.action?.args || {})}`.toLowerCase()
  return (human.constraints || []).find((c) => (c.toLowerCase().match(/[a-z0-9]+/g) || []).some((t) => t.length > 3 && text.includes(t))) || null
}
