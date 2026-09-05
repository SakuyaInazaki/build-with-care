// Global timeline: filters, SVG scrubber (one lane per agent + 人 + 系统), replay controls, list view.
import { el, svg, reconcile, emptyState, fmtTime, truncate } from './dom.js'
import { eventKind, EVENT_LABEL, SOURCE_LABEL, HUMAN_TYPES, agentsOf } from './model.js'

const ui = new WeakMap()

export function filteredEvents(session, filters) {
  const list = session?.timeline || []
  return list.filter((e) => (!filters.agent || e.agentId === filters.agent)
    && (!filters.branch || e.branchId === filters.branch)
    && (!filters.type || e.type === filters.type)
    && (!filters.human || HUMAN_TYPES.has(e.type)))
}

/**
 * ctx: { session, filters, playback:{index,playing,speed}, laneColor, countEl,
 *        on: { filter(name, value), preset(), seek(i), prev(), next(), toggle(), speed(n), exit(), jumpToCard(cardId) } }
 */
export function renderTimeline(root, ctx) {
  let u = ui.get(root)
  if (!u) { u = build(root, ctx); ui.set(root, u) }
  const { session, filters, playback } = ctx
  const all = filteredEvents(session, filters)
  const index = playback.index >= 0 ? Math.min(playback.index, all.length - 1) : -1
  const visible = index < 0 ? all : all.slice(0, index + 1)
  const current = index >= 0 ? all[index] : null

  fillSelect(u.agent, agentsOf(session), '所有 agent', filters.agent)
  fillSelect(u.branch, (session?.branches || []).map((b) => b.id), '所有分支', filters.branch)
  fillSelect(u.type, [...new Set((session?.timeline || []).map((e) => e.type))], '所有事件', filters.type, EVENT_LABEL)
  u.preset.setAttribute('aria-pressed', String(Boolean(filters.human)))

  u.play.textContent = playback.playing ? '❚❚ 暂停' : '▶ 播放'
  u.pos.textContent = all.length ? (index < 0 ? `实时 · 共 ${all.length} 条` : `第 ${index + 1} / ${all.length} 条`) : '暂无事件'
  u.bar.style.width = all.length ? `${(visible.length / all.length) * 100}%` : '0%'
  u.exit.hidden = index < 0
  u.speed.value = String(playback.speed)
  if (ctx.countEl) ctx.countEl.textContent = `${visible.length} / ${(session?.timeline || []).length} 条事件`

  drawScrubber(u, all, index, ctx)

  if (!visible.length) { u.list.replaceChildren(emptyState('暂无符合条件的事件', filters.human ? '还没有人的关键时刻：确认 spec、裁决红卡后会出现。' : '事件会随 agent 的动作实时追加。', true)); return }
  if (u.list.querySelector('.empty')) u.list.replaceChildren()
  reconcile(u.list, visible, (e) => e.id, (e) => row(e, ctx), (node, e) => { node.classList.toggle('is-current', Boolean(current) && current.id === e.id) })
  if (current) {
    const node = u.list.querySelector(`[data-key="${cssEscape(current.id)}"]`)
    if (node) { node.classList.add('is-current'); if (u.lastCurrent !== current.id) node.scrollIntoView({ block: 'nearest' }) }
  }
  u.lastCurrent = current ? current.id : ''
}

function cssEscape(value) { return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&') }

function build(root, ctx) {
  const on = ctx.on
  const agent = el('select', { class: 'input', 'aria-label': '按 agent 过滤', onChange: (e) => on.filter('agent', e.target.value) })
  const branch = el('select', { class: 'input', 'aria-label': '按分支过滤', onChange: (e) => on.filter('branch', e.target.value) })
  const type = el('select', { class: 'input', 'aria-label': '按事件类型过滤', onChange: (e) => on.filter('type', e.target.value) })
  const preset = el('button', { type: 'button', class: 'btn btn-secondary btn-sm preset', 'aria-pressed': 'false', text: '人的关键时刻', onClick: () => on.preset() })
  const filters = el('div', { class: 'tl-filters' }, agent, branch, type, preset, el('span', { class: 'spacer' }),
    el('span', { class: 'meta', text: '◆ 人 · ● 卡片/执行 · ■ 失败' }))

  const scrubber = el('div', { class: 'scrubber', 'aria-label': '时间线刻度' })
  const tip = el('div', { class: 'tl-tip', hidden: true })
  scrubber.append(tip)

  const prev = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: '‹ 上一步', onClick: () => on.prev() })
  const play = el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: '▶ 播放', onClick: () => on.toggle() })
  const next = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: '下一步 ›', onClick: () => on.next() })
  const speed = el('select', { class: 'input', 'aria-label': '播放速度', onChange: (e) => on.speed(Number(e.target.value)) },
    el('option', { value: '1', text: '1×' }), el('option', { value: '2', text: '2×' }), el('option', { value: '4', text: '4×' }))
  const bar = el('i')
  const progress = el('div', { class: 'progress', role: 'progressbar' }, bar)
  const pos = el('span', { class: 'pos' })
  const exit = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '回到实时', hidden: true, onClick: () => on.exit() })
  const controls = el('div', { class: 'tl-controls' }, prev, play, next, speed, progress, pos, exit)

  const list = el('div', { class: 'tl-list', role: 'list' })
  root.replaceChildren(filters, scrubber, controls, list)
  return { agent, branch, type, preset, scrubber, tip, play, bar, pos, exit, speed, list, lastCurrent: '' }
}

function fillSelect(select, values, allLabel, current, labels) {
  const wanted = ['', ...values]
  const existing = Array.from(select.options).map((o) => o.value)
  if (wanted.length !== existing.length || wanted.some((v, i) => v !== existing[i])) {
    select.replaceChildren(el('option', { value: '', text: allLabel }), values.map((v) => el('option', { value: v, text: labels && labels[v] ? `${labels[v]} (${v})` : v })))
  }
  select.value = current || ''
}

function drawScrubber(u, all, index, ctx) {
  const { session, laneColor } = ctx
  const agents = agentsOf(session)
  const lanes = ['人', ...agents, '系统']
  const laneOf = (e) => (HUMAN_TYPES.has(e.type) ? 0 : e.agentId && agents.includes(e.agentId) ? 1 + agents.indexOf(e.agentId) : lanes.length - 1)
  const left = 84, right = 20, laneH = 26, top = 8, axisH = 20
  const n = all.length
  const containerW = Math.max(320, u.scrubber.clientWidth || 800)
  const step = n > 1 ? Math.max(8, Math.min(32, (containerW - left - right) / (n - 1))) : 0
  const width = Math.max(containerW, left + right + Math.max(0, n - 1) * step)
  const height = top + lanes.length * laneH + axisH
  const x = (i) => left + i * step
  const y = (lane) => top + lane * laneH + laneH / 2

  const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `${n} 条事件，${lanes.length} 条泳道` })
  lanes.forEach((name, li) => {
    root.append(svg('line', { class: 'lane-line', x1: left - 8, x2: width - right + 8, y1: y(li), y2: y(li) }))
    const color = li === 0 ? 'var(--teal-500)' : li === lanes.length - 1 ? 'var(--g-500)' : laneColor(name)
    root.append(svg('circle', { cx: 10, cy: y(li), r: 4, fill: color }))
    root.append(svg('text', { class: 'lane-label', x: 18, y: y(li) + 4, text: name.length > 9 ? `${name.slice(0, 8)}…` : name }))
  })
  if (index >= 0 && n) root.append(svg('line', { class: 'playhead', x1: x(index), x2: x(index), y1: top - 2, y2: top + lanes.length * laneH }))
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor((width - left - right) / 56))))
  all.forEach((e, i) => {
    const kind = eventKind(e, session)
    const cx = x(i), cy = y(laneOf(e))
    const cls = `tick${index >= 0 && i > index ? ' future' : ''}${i === index ? ' current' : ''}`
    let mark
    if (kind.shape === 'diamond') mark = svg('rect', { class: cls, x: cx - 5, y: cy - 5, width: 10, height: 10, transform: `rotate(45 ${cx} ${cy})`, fill: kind.color })
    else if (kind.shape === 'square') mark = svg('rect', { class: cls, x: cx - 5, y: cy - 5, width: 10, height: 10, rx: 1, fill: kind.color })
    else mark = svg('circle', { class: cls, cx, cy, r: 5, fill: kind.color })
    mark.append(svg('title', { text: `#${e.sequence} ${EVENT_LABEL[e.type] || e.type}：${e.message}` }))
    // a larger transparent hit target (≥ 24px)
    const hit = svg('rect', { x: cx - 12, y: cy - 12, width: 24, height: 24, fill: 'transparent', style: 'cursor:pointer',
      onClick: () => ctx.on.seek(i),
      onPointerenter: (ev) => showTip(u, e, ev, cx, cy),
      onPointerleave: () => { u.tip.hidden = true } })
    root.append(mark, hit)
    if (i % labelEvery === 0 || i === n - 1) root.append(svg('text', { class: 'axis', x: cx, y: height - 6, 'text-anchor': 'middle', text: `#${e.sequence}` }))
  })
  const old = u.scrubber.querySelector('svg')
  if (old) old.replaceWith(root); else u.scrubber.append(root)
}

function showTip(u, e, ev, cx, cy) {
  const tip = u.tip
  tip.replaceChildren(el('b', { text: `#${e.sequence} · ${EVENT_LABEL[e.type] || e.type} · ${SOURCE_LABEL[e.source] || e.source}` }), el('span', { text: truncate(e.message, 160) }))
  tip.hidden = false
  const box = u.scrubber.getBoundingClientRect()
  const px = ev.clientX - box.left + u.scrubber.scrollLeft
  tip.style.left = `${Math.max(8, Math.min(px + 12, u.scrubber.scrollWidth - 330))}px`
  tip.style.top = `${Math.max(4, cy - 56)}px`
}

function row(e, ctx) {
  const kind = eventKind(e, ctx.session)
  const node = el('div', { class: `ev-row${e.cardId ? ' has-card' : ''}`, role: 'listitem', title: e.cardId ? '点击定位到对应卡片' : '' },
    el('span', { class: 'seq', text: `#${e.sequence}` }),
    el('span', { class: 'src', text: `${SOURCE_LABEL[e.source] || e.source} · ${fmtTime(e.at)}` }),
    el('div', { class: 'line' },
      el('span', { class: `type ${kind.cat === 'human' ? 'human' : ''}`, style: { '--c': kind.color } }, el('i'), EVENT_LABEL[e.type] || e.type),
      el('span', { class: 'msg', text: e.message }),
      el('span', { class: 'who', text: [e.agentId, e.branchId !== 'main' ? e.branchId : '', e.turn != null ? `t${e.turn}${e.step != null ? `·s${e.step}` : ''}` : ''].filter(Boolean).join(' · ') })))
  if (e.cardId) node.addEventListener('click', () => ctx.on.jumpToCard(e.cardId))
  return node
}
