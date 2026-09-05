// One-page session report (also the print layout).
import { el, fmtDuration, fmtDateTime, emptyState } from './dom.js'
import { reportOf, cardTone, stateLabel, TONE_COLOR, TONE_LABEL, TONE_GLYPH, modeLabel, cardTitle } from './model.js'

let lastSig = ''

export function renderReport(root, ctx) {
  const { session } = ctx
  if (!session) { lastSig = ''; root.replaceChildren(emptyState('暂无会话报告', '结束会话后，这里会生成一页“人做了哪些判断”的报告。')); return }
  const r = reportOf(session)
  let sig = ''
  try { sig = JSON.stringify([r, session.cards.map((c) => [c.id, c.state, c.verificationStatus, c.postHocDecision]), session.endedAt]) } catch { sig = String(Date.now()) }
  if (sig === lastSig && root.childElementCount) return
  lastSig = sig
  const cards = session.cards || []
  const frag = document.createDocumentFragment()

  const ended = Boolean(session.endedAt || r.endedAt)
  frag.append(el('p', { class: 'report-headline', text: r.summary || `本会话 agent 做了 ${r.decisions} 个决定，你放过 ${r.allowed} 个、翻案 ${r.overrides} 次，其中 ${r.directionCorrections} 次纠正了跑偏的方向。` }))
  frag.append(el('p', { class: 'report-sub', text: `${session.title || session.sessionId} · ${modeLabel(session.mode)} · ${r.startedAt ? fmtDateTime(r.startedAt) : ''} · 时长 ${fmtDuration(r.durationMs)}${ended ? ' · 已结束（报告为最终）' : ' · 进行中（报告实时更新）'}` }))

  const tiles = [
    ['人做的判断', r.humanDecisions, 'spec 确认 + 裁决 + 翻案 + 叫停', true],
    ['agent 自主拍板', r.agentDecisions, '人没指定、它自己定的', false],
    ['翻案', r.overrides, '拒绝原动作，向前纠偏', false],
    ['纠正方向', r.directionCorrections, '红卡被备选/改写', true],
    ['green 证据', r.verificationEvidence, '执行器绑定的通过证据', false],
    ['未验证', r.unverified, '执行成功但无证据', false],
    ['运行失败 · 求助', `${r.runtimeFailures} · ${r.blockedHelp}`, '重试次数 · 升级阻塞求助', false],
    ['不可逆副作用', r.irreversibleSideEffects, 'fork 不能撤销的动作', false],
  ]
  frag.append(el('div', { class: 'tiles' }, tiles.map(([label, value, hint, accent]) => el('div', { class: `tile${accent ? ' accent' : ''}` },
    el('div', { class: 'v', text: String(value ?? 0) }), el('div', { class: 'l', text: label }), el('div', { class: 'h', text: hint })))))

  // stacked bar of byColor
  const order = ['red', 'blue', 'gray', 'green', 'failed']
  const total = order.reduce((s, k) => s + (r.byColor[k] || 0), 0)
  const stack = el('div', { class: 'stack', role: 'img', 'aria-label': order.map((k) => `${TONE_LABEL[k]} ${r.byColor[k] || 0}`).join('，') })
  order.forEach((k) => {
    const n = r.byColor[k] || 0
    if (!n) return
    const pct = (n / total) * 100
    const seg = el('i', { style: { width: `${pct}%`, '--c': TONE_COLOR[k] }, dataset: { c: k }, title: `${TONE_LABEL[k]}：${n}` })
    if (pct >= 9) seg.append(el('span', { text: String(n) }))
    stack.append(seg)
  })
  frag.append(el('div', { class: 'stack-wrap' },
    el('div', { class: 'stack-title', text: `卡片按颜色分布（共 ${total} 张）` }),
    total ? stack : el('div', { class: 'meta', text: '还没有卡片。' }),
    el('div', { class: 'stack-legend' }, order.map((k) => el('span', null, el('i', { style: { '--c': TONE_COLOR[k] } }), `${TONE_GLYPH[k]} ${TONE_LABEL[k]} `, el('b', { text: String(r.byColor[k] || 0) }))))))

  // per-agent table + corrections
  const cols = el('div', { class: 'report-cols' })
  const agentsBox = el('div', null, el('h3', { text: '按 agent' }))
  if (r.perAgent.length) {
    const table = el('table', { class: 'agents' },
      el('thead', null, el('tr', null, el('th', { text: 'agent' }), ['动作', '自主', '红', '蓝', '灰', '绿', '失败'].map((h) => el('th', { class: 'n', text: h })))),
      el('tbody', null, r.perAgent.map((a) => el('tr', null, el('td', { text: a.agentId }), [a.actions, a.selfDirected, a.red, a.blue, a.gray, a.verified, a.failed].map((v) => el('td', { class: 'n', text: String(v ?? 0) }))))))
    agentsBox.append(table)
  } else agentsBox.append(el('div', { class: 'meta', text: '尚无 agent 接入。' }))
  cols.append(agentsBox)

  const corrBox = el('div', null, el('h3', { text: `人的关键纠偏（${r.corrections.length}）` }))
  if (r.corrections.length) {
    corrBox.append(el('div', { class: 'corr-list' }, r.corrections.map((c) => el('div', { class: 'corr' },
      el('div', { class: 'k' }, el('b', { text: kindLabel(c.kind) }), c.turn != null ? `turn ${c.turn}` : null, c.agentId || null, el('span', { class: 'badge', text: modeLabel(c.mode) }), c.postHoc ? el('span', { class: 'pill amber', text: '事后翻案' }) : null, c.branchId && c.branchId !== 'main' ? c.branchId : null),
      el('div', { class: 'ba' }, el('span', { class: 'before', text: c.before || '原动作' }), el('span', { class: 'arrow', text: '→' }), el('span', { class: 'after', text: c.after || '' }))))))
  } else corrBox.append(el('div', { class: 'meta', text: '还没有纠偏：如果 agent 全程没跑偏，这里为空是好事。' }))
  cols.append(corrBox)
  frag.append(cols)

  // unresolved
  const open = cards.filter((c) => c.state === 'pending' || c.state === 'failed' || (c.executionStatus === 'succeeded' && c.verificationStatus !== 'passed'))
  const openBox = el('div', { class: 'report-cols', style: { marginTop: '24px' } })
  const openList = el('div', null, el('h3', { text: `尚未闭环（${open.length}）` }))
  openList.append(open.length
    ? el('ul', { class: 'open-list' }, open.map((c) => el('li', null, el('span', { class: `pill ${cardTone(c)}`, text: `${TONE_GLYPH[cardTone(c)]} ${stateLabel(c)}` }), el('span', { text: `turn ${c.turn} · ${c.agentId} · ${cardTitle(c)}${c.executionStatus === 'succeeded' && c.verificationStatus !== 'passed' ? '（无执行器证据）' : ''}` }))))
    : el('div', { class: 'meta', text: '全部闭环：没有待裁决、失败或未验证的步骤。' }))
  openBox.append(openList)
  openBox.append(el('div', null, el('h3', { text: '口径' }), el('ul', { class: 'open-list' },
    el('li', { text: '只有执行器绑定的通过证据才算 green；人工复核只记录，不变绿。' }),
    el('li', { text: '翻案只向前生效；rewind-and-fork 保留原分支，但不撤销外部副作用。' }),
    el('li', { text: `判色来源：${new Set(cards.map((c) => c.provenance?.judge || 'deterministic')).size ? [...new Set(cards.map((c) => c.provenance?.judge || 'deterministic'))].join(' / ') : 'deterministic'}` }))))
  frag.append(openBox)

  frag.append(el('div', { class: 'report-foot' }, el('span', { text: '归因人的判断，不归因代码行。' }), el('span', { text: `在场 · ${session.sessionId} · 生成于 ${fmtDateTime(new Date().toISOString())}` })))
  root.replaceChildren(frag)
}

function kindLabel(kind) { return { allow: '放行', alternative: '选备选', rewrite: '改写', cancel: '叫停' }[kind] || kind }
