import { api, ApiError, openEvents } from './js/api.js'
import { $, el, fmtDateTime } from './js/dom.js'
import { pendingCards, cardById, laneColorFor, modeLabel } from './js/model.js'
import { renderLedger } from './js/ledger.js'
import { buildAdjudicator } from './js/adjudicate.js'
import { renderTimeline } from './js/timeline.js'
import { renderBranches } from './js/branches.js'
import { renderReport } from './js/report.js'

const state = { session: null, config: null, selectedMode: 'forward-only', currentCardId: '', busyCardId: '', filters: { agent: '', branch: '', type: '', human: false }, playback: { index: -1, playing: false, speed: 1 }, poll: null, events: null, menu: false }
const $id = (id) => $(id)
const controls = ['confirmBtn', 'draftBtn', 'addConstraintBtn', 'demoBtn', 'runBtn', 'endBtn', 'cancelBtn', 'newSessionBtn']

function toast(message, kind = 'error') {
  const node = el('div', { class: `toast ${kind}`, role: 'alert' }, el('span', { text: message }), el('button', { class: 'x', type: 'button', 'aria-label': '关闭提示', text: '×', onClick: () => node.remove() }))
  $id('toasts').append(node)
  setTimeout(() => node.remove(), 6000)
}

async function call(task) {
  try { return await task() } catch (error) { toast(error instanceof ApiError ? error.message : String(error)); throw error }
}

function setBusy(busy, ids = controls) { ids.forEach((id) => { const node = $id(id); if (node) node.disabled = busy }) }
function mergeSession(next) { if (!next) return; state.session = state.session ? { ...state.session, ...next } : next; render() }
function closeEvents() { state.events?.close(); state.events = null; clearInterval(state.poll); state.poll = null }

function connect() {
  closeEvents()
  if (!state.session) return
  const id = state.session.sessionId
  const onState = (next) => mergeSession(next)
  const onUpdate = (patch) => mergeSession(patch)
  state.events = openEvents(id, { onState, onUpdate, onTimeline: (event) => {
    const events = state.session?.timeline || []
    if (!events.some((item) => item.id === event.id)) mergeSession({ timeline: [...events, event] })
  }, onOpen: () => setLive('sse', '实时'), onError: () => { setLive('polling', '轮询'); startPolling() } })
  setLive('connecting', '连接中')
}
function setLive(mode, label) { const node = $id('live'); node.dataset.state = mode; $id('liveText').textContent = label }
function startPolling() {
  if (state.poll || !state.session) return
  state.poll = setInterval(async () => { try { mergeSession(await api.state(state.session.sessionId)) } catch { setLive('offline', '服务不可用') } }, 2500)
}

async function selectSession(id) {
  if (!id) return
  const next = await call(() => api.state(id)); state.session = next; state.currentCardId = ''; connect(); render()
}
async function createSession(mode = state.selectedMode) {
  setBusy(true)
  try { state.session = await call(() => api.createSession(mode)); connect(); render() } finally { setBusy(false) }
}

function renderSessions(list) {
  const select = $id('sessionSelect'); select.replaceChildren(el('option', { value: '', text: '选择会话…' }), ...(list || []).map((item) => el('option', { value: item.sessionId, text: `${item.title || item.sessionId} · ${item.counts?.cards || 0} 卡` })))
  if (state.session) select.value = state.session.sessionId
}
function renderConstraints() {
  const list = $id('constraintList'); const constraints = state.session?.spec?.constraints || state.draft?.constraints || []
  list.replaceChildren(...constraints.map((value, index) => el('li', null, el('input', { class: 'input', value, 'aria-label': `约束 ${index + 1}`, onInput: (event) => { if (!state.draft) state.draft = { request: $id('requestInput').value, constraints: [...constraints], source: 'manual' }; state.draft.constraints[index] = event.target.value } }), el('button', { class: 'remove', type: 'button', 'aria-label': `删除约束 ${index + 1}`, text: '×', onClick: () => { constraints.splice(index, 1); state.draft = { request: $id('requestInput').value, constraints, source: 'manual' }; renderConstraints() } }))))
}
function currentConstraints() { return Array.from($id('constraintList').querySelectorAll('input')).map((input) => input.value.trim()).filter(Boolean) }

async function draft() {
  const request = $id('requestInput').value.trim(); if (!request) { $id('requestInput').focus(); toast('请先填写一句话需求'); return }
  setBusy(true, ['draftBtn', 'confirmBtn', 'addConstraintBtn']);
  try { state.draft = await call(() => api.draftSpec(state.session.sessionId, request)); renderConstraints(); $id('draftSource').hidden = false; $id('draftSource').textContent = state.draft.source === 'llm' ? 'LLM 扩写' : '模板扩写' } finally { setBusy(false) }
}
function addConstraint() { if (!state.draft) state.draft = { request: $id('requestInput').value.trim(), constraints: currentConstraints(), source: 'manual' }; state.draft.constraints.push(''); renderConstraints(); const inputs = $id('constraintList').querySelectorAll('input'); inputs[inputs.length - 1]?.focus() }
async function confirmSpec(event) {
  event.preventDefault(); const request = $id('requestInput').value.trim(); const constraints = currentConstraints()
  if (!request || constraints.length < 2) { toast('请填写需求，并至少保留两条约束'); return }
  setBusy(true)
  try { mergeSession(await call(() => api.confirmSpec(state.session.sessionId, { id: `spec-${Date.now()}`, request, constraints, confirmed: true }))); $id('setupForm').hidden = true; toast('spec 已确认，可以运行', 'success') } finally { setBusy(false) }
}
async function runDemo(scenario) { closeMenu(); if (!state.session?.spec) { toast('请先确认 spec'); return } setBusy(true); try { await call(() => api.demo(state.session.sessionId, scenario)); mergeSession(await api.state(state.session.sessionId)) } finally { setBusy(false) } }
async function runReal() { if (!state.session?.spec) { toast('请先确认 spec'); return } setBusy(true); try { await call(() => api.run(state.session.sessionId)); mergeSession(await api.state(state.session.sessionId)) } finally { setBusy(false) } }
async function end() { if (!state.session) return; setBusy(true); try { mergeSession(await call(() => api.end(state.session.sessionId))); closeEvents() } finally { setBusy(false) } }
async function cancel() { if (!state.session) return; setBusy(true); try { mergeSession(await call(() => api.cancel(state.session.sessionId))) } finally { setBusy(false) } }

function pendingFocus(card) { state.currentCardId = card.id; renderDock() }
async function decide(card, decision) { state.busyCardId = card.id; render(); try { mergeSession(await call(() => api.decide(state.session.sessionId, card.id, decision))); state.currentCardId = ''; renderDock() } finally { state.busyCardId = '' ; render() } }
function openAdjudicator(card) { const dialog = $id('adjudicator'); const built = buildAdjudicator(card, { postHoc: card.state !== 'pending', busy: state.busyCardId === card.id, session: state.session, config: state.config, laneColor: laneColorFor(state.session), onDecide: (decision) => { dialog.close(); void decide(card, decision) } }); dialog.replaceChildren(built.root); if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', ''); }
function renderDock() { const dock = $id('dock'); const card = cardById(state.session, state.currentCardId) || pendingCards(state.session)[0]; if (!card) { dock.hidden = true; return } dock.hidden = false; const built = buildAdjudicator(card, { session: state.session, config: state.config, laneColor: laneColorFor(state.session), busy: state.busyCardId === card.id, onDecide: (decision) => void decide(card, decision) }); dock.replaceChildren(el('div', { class: 'dock-head' }, el('h2', { id: 'dockTitle', text: '需要你裁决' }), el('span', { class: 'count', text: '红卡' })), el('div', { class: 'dock-body' }, built.root)); built.tick() }
function closeMenu() { state.menu = false; $id('demoMenuList').hidden = true; $id('demoBtn').setAttribute('aria-expanded', 'false') }

function render() {
  const session = state.session; const has = Boolean(session); $id('onboarding').hidden = has; $id('grid').hidden = !has; $id('timelinePanel').hidden = !has; $id('reportPanel').hidden = !has
  if (!has) return
  $id('modeBadge').hidden = false; $id('modeBadge').className = `badge ${session.mode === 'rewind-and-fork' ? 'mode-fork' : 'mode-fwd'}`; $id('modeBadge').textContent = modeLabel(session.mode); $id('sessionTime').textContent = fmtDateTime(session.createdAt)
  $id('specPanel').hidden = !session.spec; $id('setupPanel').hidden = Boolean(session.spec); $id('runBtn').disabled = !state.config?.llm?.agent?.configured || !session.spec || Boolean(session.runner?.state === 'running' || session.runner?.state === 'waiting-human')
  $id('runnerChip').dataset.state = session.runner?.state === 'waiting-human' ? 'waiting' : session.runner?.state || 'idle'; $id('runnerChip').textContent = session.runner?.state || '空闲'; $id('specRequest').textContent = session.spec?.request || ''; $id('specList').replaceChildren(...(session.spec?.constraints || []).map((item) => el('li', { text: item }))); $id('specCount').textContent = session.spec ? `${session.spec.constraints.length} 条约束` : ''
  renderConstraints(); renderDock(); renderLedger($id('ledgerList'), { session, config: state.config, currentCardId: state.currentCardId, busyCardId: state.busyCardId, laneColor: laneColorFor(session), actions: { focusDock: pendingFocus, openAdjudicator, decide, verifyHuman: (card) => call(() => api.verify(session.sessionId, card.id, false, '人工复核')) } }); renderBranches($id('branchBody'), { session }); renderTimeline($id('timelineBody'), { session, filters: state.filters, playback: state.playback, laneColor: laneColorFor(session), countEl: $id('eventCount'), on: { filter: (name, value) => { state.filters[name] = value; render() }, preset: () => { state.filters.human = !state.filters.human; render() }, seek: (index) => { state.playback.index = index; render() }, prev: () => { state.playback.index = Math.max(0, state.playback.index - 1); render() }, next: () => { state.playback.index++; render() }, toggle: () => { state.playback.playing = !state.playback.playing; render() }, speed: (speed) => { state.playback.speed = speed; render() }, exit: () => { state.playback.index = -1; render() }, jumpToCard: (id) => { state.currentCardId = id; render(); $id('ledger').scrollIntoView({ behavior: 'smooth' }) } } }); renderReport($id('reportBody'), { session })
}

function bind() {
  $id('sessionSelect').addEventListener('change', (event) => void selectSession(event.target.value)); $id('newSessionBtn').addEventListener('click', () => void createSession()); $id('onboardingCreate').addEventListener('click', () => void createSession()); $id('setupForm').addEventListener('submit', (event) => void confirmSpec(event)); $id('draftBtn').addEventListener('click', () => void draft()); $id('addConstraintBtn').addEventListener('click', addConstraint); document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => { state.selectedMode = button.dataset.mode; document.querySelectorAll('[data-mode]').forEach((item) => item.setAttribute('aria-checked', String(item === button))) })); $id('runBtn').addEventListener('click', () => void runReal()); $id('endBtn').addEventListener('click', () => void end()); $id('cancelBtn').addEventListener('click', () => void cancel()); $id('printBtn').addEventListener('click', () => window.print()); $id('reportPrintBtn').addEventListener('click', () => window.print());
  $id('demoBtn').addEventListener('click', () => { state.menu = !state.menu; $id('demoMenuList').hidden = !state.menu; $id('demoBtn').setAttribute('aria-expanded', String(state.menu)) }); $id('demoMenuList').addEventListener('click', (event) => { const item = event.target.closest('[data-scenario]'); if (item) void runDemo(item.dataset.scenario) }); document.addEventListener('click', (event) => { if (!event.target.closest('#demoMenu')) closeMenu() }); $id('adjudicator').addEventListener('click', (event) => { if (event.target === $id('adjudicator')) $id('adjudicator').close() });
}

async function init() { bind(); try { state.config = await api.config(); const list = await api.sessions(); renderSessions(list); if (list[0]) await selectSession(list[0].sessionId); else render() } catch (error) { setLive('offline', '离线'); if (!(error instanceof ApiError)) toast(String(error)) } }
void init()
