// DOM helpers. Everything goes through textContent / createElement — innerHTML is never used.

export const $ = (id) => document.getElementById(id)

const SVG_NS = 'http://www.w3.org/2000/svg'

/** el('div', { class: 'x', text: '…', onClick: fn, dataset: {…} }, ...children) */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  applyProps(node, props)
  appendChildren(node, children)
  return node
}

export function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue
    if (key === 'text') node.textContent = String(value)
    else if (key === 'class') node.setAttribute('class', value)
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
    else node.setAttribute(key, String(value))
  }
  appendChildren(node, children)
  return node
}

function applyProps(node, props) {
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = String(value)
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value)
    else if (key === 'html') throw new Error('innerHTML is forbidden')
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
    else if (key === 'disabled' || key === 'hidden' || key === 'open' || key === 'checked' || key === 'selected') node[key] = Boolean(value)
    else if (key === 'value') node.value = String(value)
    else node.setAttribute(key, value === true ? '' : String(value))
  }
}

function appendChildren(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === '') continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
}

export const button = (label, onClick, className = 'btn btn-secondary', extra = {}) => el('button', { type: 'button', class: className, onClick, ...extra }, label)

/**
 * Keyed list reconciliation. Existing nodes with the same key are kept (so <details> open
 * state, focus and scroll position survive); `update` refreshes their content in place.
 */
export function reconcile(container, items, key, create, update) {
  const existing = new Map()
  for (const child of Array.from(container.children)) if (child.dataset.key) existing.set(child.dataset.key, child)
  const next = []
  for (const item of items) {
    const k = String(key(item))
    let node = existing.get(k)
    if (node) { existing.delete(k); if (update) update(node, item) } else { node = create(item); node.dataset.key = k }
    next.push(node)
  }
  for (const stale of existing.values()) stale.remove()
  next.forEach((node, index) => { if (container.children[index] !== node) container.insertBefore(node, container.children[index] || null) })
  return next
}

export function clear(node) { node.replaceChildren() }

/** Preserve open state of `<details data-section>` inside a node across a rebuild. */
export function rememberOpen(node) {
  const open = new Set()
  node.querySelectorAll('details[data-section]').forEach((d) => { if (d.open) open.add(d.dataset.section) })
  return open
}
export function restoreOpen(node, open) {
  if (!open || !open.size) return
  node.querySelectorAll('details[data-section]').forEach((d) => { if (open.has(d.dataset.section)) d.open = true })
}

// ---------- formatting ----------
const pad = (n) => String(n).padStart(2, '0')
export function fmtTime(iso) { if (!iso) return ''; const d = new Date(iso); if (Number.isNaN(d.getTime())) return ''; return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` }
export function fmtDateTime(iso) { if (!iso) return ''; const d = new Date(iso); if (Number.isNaN(d.getTime())) return ''; return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}` }
export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60); const r = s % 60
  if (m < 60) return r ? `${m} 分 ${r} 秒` : `${m} 分钟`
  const h = Math.floor(m / 60)
  return `${h} 小时 ${m % 60} 分`
}
export function fmtCountdown(ms) { const s = Math.max(0, Math.ceil(ms / 1000)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}` }
export function shortId(id) { if (!id) return ''; return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id }
export function truncate(text, max = 80) { const s = String(text ?? ''); return s.length > max ? `${s.slice(0, max - 1)}…` : s }

/** "path=store/db.sqlite · provider=memory" — compact tool-arg summary. */
export function argsSummary(args, max = 96) {
  if (!args || typeof args !== 'object') return ''
  const parts = []
  for (const [key, value] of Object.entries(args)) {
    let v = value
    if (typeof v === 'object' && v !== null) { try { v = JSON.stringify(v) } catch { v = '[object]' } }
    v = String(v).replace(/\s+/g, ' ')
    parts.push(`${key}=${v.length > 40 ? `${v.slice(0, 39)}…` : v}`)
  }
  return truncate(parts.join(' · '), max)
}

export function json(value) { try { return JSON.stringify(value, null, 2) } catch { return String(value) } }

export function emptyState(title, hint, compact = false) {
  const icon = svg('svg', { viewBox: '0 0 48 48', 'aria-hidden': 'true' },
    svg('rect', { x: 6, y: 10, width: 36, height: 28, rx: 4, fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }),
    svg('path', { d: 'M14 20h20M14 26h14', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' }))
  return el('div', { class: `empty${compact ? ' compact' : ''}` }, icon, el('b', { text: title }), hint ? el('span', { text: hint }) : null)
}
