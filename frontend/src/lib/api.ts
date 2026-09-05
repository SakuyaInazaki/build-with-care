import type { PublicSettings, RunState } from '../../../decision-desk/shared/types.js'

export async function api<T>(url: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(url, {
    ...(body !== undefined
      ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? '操作未完成，请稍后重试。')
  return data as T
}
export const bootstrap = () => api<{ runs: RunState[]; settings: PublicSettings }>('/api/bootstrap')
export const requestId = () => crypto.randomUUID()
export const dateLabel = (value: string) =>
  new Date(value).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
export const timeLabel = (value: string) =>
  new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
