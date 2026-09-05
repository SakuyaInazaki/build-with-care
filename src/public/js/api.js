// HTTP + SSE client for the decision-stream API (contract v2, tolerant of v1 backends).

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code }
}

export async function request(path, options = {}) {
  let response
  try { response = await fetch(path, options) } catch (error) { throw new ApiError(0, 'network', `无法连接本地服务（${error.message}）`) }
  let payload = null
  const text = await response.text()
  if (text) { try { payload = JSON.parse(text) } catch { payload = null } }
  if (!response.ok) {
    const err = payload && payload.error ? payload.error : {}
    throw new ApiError(response.status, err.code || `http_${response.status}`, err.message || `请求失败（${response.status}）`)
  }
  return payload
}

const enc = encodeURIComponent
export const get = (path) => request(path)
export const post = (path, body) => request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })

export const api = {
  config: () => get('/api/config'),
  sessions: () => get('/api/sessions'),
  createSession: (mode, title) => post('/api/sessions', title ? { mode, title } : { mode }),
  state: (id) => get(`/api/sessions/${enc(id)}/state`),
  confirmSpec: (id, spec) => post(`/api/sessions/${enc(id)}/spec`, spec),
  draftSpec: (id, requestText) => post(`/api/sessions/${enc(id)}/spec/draft`, { request: requestText }),
  end: (id) => post(`/api/sessions/${enc(id)}/end`),
  cancel: (id) => post(`/api/sessions/${enc(id)}/cancel`),
  demo: (id, scenario) => post(`/api/sessions/${enc(id)}/demo`, { scenario }),
  run: (id, body) => post(`/api/sessions/${enc(id)}/run`, body || {}),
  action: (id, action) => post(`/api/sessions/${enc(id)}/actions`, action),
  decide: (id, cardId, decision) => post(`/api/sessions/${enc(id)}/cards/${enc(cardId)}/decision`, decision),
  cancelCard: (id, cardId) => post(`/api/sessions/${enc(id)}/cards/${enc(cardId)}/cancel`),
  verify: (id, cardId, passed, detail) => post(`/api/sessions/${enc(id)}/verify`, { cardId, passed, detail }),
  report: (id) => get(`/api/sessions/${enc(id)}/report`),
  addConstraint: (id, text) => post(`/api/sessions/${enc(id)}/constraints`, { text }),
  unit: (id, unit) => post(`/api/sessions/${enc(id)}/units`, unit),
}

/**
 * Open the SSE stream for a session. Returns { close }.
 * handlers: onOpen, onState(state), onUpdate(patch), onTimeline(event), onError(closed:boolean)
 */
export function openEvents(id, handlers) {
  if (typeof EventSource === 'undefined') { handlers.onError?.(true); return { close() {} } }
  const source = new EventSource(`/api/sessions/${enc(id)}/events`)
  const parse = (raw) => { try { return JSON.parse(raw) } catch { return null } }
  source.addEventListener('open', () => handlers.onOpen?.())
  source.addEventListener('state', (e) => { const data = parse(e.data); if (data) handlers.onState?.(data) })
  source.addEventListener('update', (e) => { const data = parse(e.data); if (data) handlers.onUpdate?.(data) })
  source.addEventListener('timeline', (e) => { const data = parse(e.data); if (data) handlers.onTimeline?.(data) })
  source.addEventListener('error', () => handlers.onError?.(source.readyState === EventSource.CLOSED))
  return { close() { source.close() } }
}
