// Branch view (rewind-and-fork): small SVG tree — main → branch-n at fork turn N.
import { el, svg, fmtTime } from './dom.js'
import { cardTone, TONE_COLOR } from './model.js'

export function renderBranches(root, ctx) {
  const { session } = ctx
  if (!session) { root.replaceChildren(el('div', { class: 'note', text: '选择会话后显示分支。' })); return }
  if (session.mode !== 'rewind-and-fork') {
    root.replaceChildren(el('div', { class: 'note', text: 'forward-only：不产生分支。纠偏以约束注入，只影响后续步骤，历史不改写。' }))
    return
  }
  const branches = [...(session.branches || [])]
  const cards = session.cards || []
  if (!branches.length) { root.replaceChildren(el('div', { class: 'note', text: '尚无分支。' })); return }
  branches.sort((a, b) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
  const maxTurn = Math.max(1, ...cards.map((c) => c.turn || 0), ...branches.map((b) => b.forkTurn || 0))
  const width = 340, left = 96, right = 16, rowH = 34, top = 16
  const height = top + branches.length * rowH
  const x = (t) => left + (t / maxTurn) * (width - left - right)
  const y = (i) => top + i * rowH
  const rowOf = (id) => branches.findIndex((b) => b.id === id)
  const lastTurn = (b) => Math.max(b.forkTurn || 0, ...cards.filter((c) => c.branchId === b.id).map((c) => c.turn || 0))

  const tree = svg('svg', { class: 'branch-svg', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `${branches.length} 条分支` })
  branches.forEach((b, i) => {
    const start = b.forkTurn || 0
    const end = Math.max(lastTurn(b), b.active ? maxTurn : start)
    const color = b.active ? 'var(--teal-500)' : 'var(--g-400)'
    if (b.parentId && rowOf(b.parentId) >= 0) {
      const py = y(rowOf(b.parentId))
      tree.append(svg('path', { d: `M ${x(start)} ${py} C ${x(start)} ${py + 14}, ${x(start)} ${y(i) - 14}, ${x(start) + 6} ${y(i)}`, fill: 'none', stroke: color, 'stroke-width': 2 }))
    }
    tree.append(svg('line', { x1: x(start) + (b.parentId ? 6 : 0), x2: Math.max(x(end), x(start) + 12), y1: y(i), y2: y(i), stroke: color, 'stroke-width': b.active ? 3 : 2, 'stroke-linecap': 'round' }))
    tree.append(svg('text', { x: 8, y: y(i) + 4, class: 'lane-label', fill: b.active ? 'var(--teal-700)' : 'var(--ink-3)', 'font-size': 12, 'font-weight': 600, text: b.id.length > 10 ? `${b.id.slice(0, 9)}…` : b.id }))
    cards.filter((c) => c.branchId === b.id).forEach((c) => {
      const dot = svg('circle', { cx: x(c.turn || 0), cy: y(i), r: 5, fill: TONE_COLOR[cardTone(c)], stroke: 'var(--surface)', 'stroke-width': 2 })
      dot.append(svg('title', { text: `turn ${c.turn} · ${c.action?.description || ''}` }))
      tree.append(dot)
    })
    if (b.forkTurn != null) tree.append(svg('text', { x: x(start), y: y(i) - 9, 'text-anchor': 'middle', 'font-size': 10, fill: 'var(--ink-3)', text: `fork@t${b.forkTurn}` }))
  })

  const list = el('ul', { class: 'branch-list' }, branches.map((b) => el('li', { class: `branch-item${b.active ? ' active' : ''}` },
    el('span', { class: 'id', text: b.id }),
    el('span', { class: `pill ${b.active ? 'teal' : 'gray'}`, text: b.active ? '● 活动分支' : (b.parentId || branches.some((c) => c.parentId === b.id)) ? '⏸ 已暂存' : '原始' }),
    b.forkTurn != null ? el('span', { class: 'meta', text: `从 ${b.parentId || 'main'} 的 turn ${b.forkTurn} 分叉${b.createdAt ? ` · ${fmtTime(b.createdAt)}` : ''}` }) : null)))
  root.replaceChildren(tree, list, el('div', { class: 'note warn', text: '⚠ 逻辑 fork 保留原分支，但不回滚物理文件、不撤销邮件/网络请求等外部副作用。' }))
}
