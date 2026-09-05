import { useEffect, useRef, useState } from 'react'
import { Bell, BellOff } from 'lucide-react'
import type { RunState } from '../../../decision-desk/shared/types.js'
import { attentionItems } from '../lib/attention.js'

const preferenceKey = 'kanzheban.desktop-notifications'
const historyKey = 'kanzheban.notified-actions'
function read(key: string) { try { return localStorage.getItem(key) } catch { return null } }
function write(key: string, value: string) { try { localStorage.setItem(key, value) } catch { /* In-memory fallback remains available. */ } }
const permission = () => 'Notification' in window ? Notification.permission : 'unsupported'

export function useAttention(runs: RunState[], open: (id: string) => void) {
  const items = attentionItems(runs)
  const [enabled, setEnabled] = useState(() => read(preferenceKey) !== 'off')
  const [access, setAccess] = useState(permission)
  const [permissionError, setPermissionError] = useState('')
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(sessionStorage.getItem('kanzheban.dismissed-actions') ?? '[]')) }
    catch { return new Set() }
  })
  const [focused, setFocused] = useState(() => document.visibilityState === 'visible' && document.hasFocus())
  const issued = useRef(new Map<string, Notification>())
  const seen = useRef<Set<string>>(new Set())
  const openRef = useRef(open)
  openRef.current = open
  const itemsRef = useRef(items)
  itemsRef.current = items
  useEffect(() => {
    try { seen.current = new Set(JSON.parse(read(historyKey) ?? '[]')) } catch { /* Invalid optional preference. */ }
    const refresh = () => {
      setFocused(document.visibilityState === 'visible' && document.hasFocus())
      setAccess(permission())
    }
    window.addEventListener('focus', refresh)
    window.addEventListener('blur', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      window.removeEventListener('blur', refresh)
      document.removeEventListener('visibilitychange', refresh)
      for (const notification of issued.current.values()) notification.close()
    }
  }, [])
  const identity = items.map(item => item.key).join('|')
  useEffect(() => {
    const current = itemsRef.current
    document.title = current.length ? `（${current.length}）待处理 · 看着办` : '看着办 · 工作空间'
    const keys = new Set(current.map(item => item.key))
    for (const [key, notification] of issued.current) {
      if (!keys.has(key) || !enabled) { notification.close(); issued.current.delete(key) }
    }
    if (!enabled || access !== 'granted' || focused) return
    try {
      for (const key of JSON.parse(read(historyKey) ?? '[]')) seen.current.add(key)
    } catch { /* Keep in-memory deduplication. */ }
    for (const item of current) {
      if (seen.current.has(item.key)) continue
      try {
        const notification = new Notification('看着办 · 需要你处理', {
          body: `${item.task.slice(0, 60)}\n${item.message}`, tag: item.key,
        })
        notification.onclick = () => {
          window.focus()
          if (itemsRef.current.some(current => current.key === item.key)) openRef.current(item.runId)
          notification.close()
        }
        notification.onerror = () => setPermissionError('桌面提醒未能显示，请检查浏览器及系统通知设置。')
        issued.current.set(item.key, notification)
        seen.current.add(item.key)
        write(historyKey, JSON.stringify([...seen.current].slice(-500)))
      } catch {
        setPermissionError('当前浏览器无法显示桌面提醒，页面提醒仍然有效。')
        break
      }
    }
  }, [identity, enabled, access, focused])
  const toggle = async () => {
    setPermissionError('')
    if (enabled && access === 'granted') { setEnabled(false); write(preferenceKey, 'off'); return }
    if (access === 'unsupported') { setPermissionError('当前浏览器不支持桌面提醒。'); return }
    if (permission() === 'denied') { setPermissionError('通知权限已被关闭，请在浏览器的网站设置中允许通知。'); return }
    try {
      const result = await Notification.requestPermission()
      setAccess(result)
      if (result === 'granted') { setEnabled(true); write(preferenceKey, 'on') }
      else setPermissionError(result === 'denied' ? '通知权限未获允许，页面提醒仍然有效。' : '尚未开启桌面提醒。')
    } catch { setPermissionError('无法申请通知权限，请检查浏览器设置。') }
  }
  const dismiss = (key: string) => {
    setDismissed(previous => {
      const next = new Set(previous).add(key)
      try { sessionStorage.setItem('kanzheban.dismissed-actions', JSON.stringify([...next].slice(-500))) } catch { /* In-memory dismissal. */ }
      return next
    })
    issued.current.get(key)?.close()
    issued.current.delete(key)
    seen.current.add(key)
    write(historyKey, JSON.stringify([...seen.current].slice(-500)))
  }
  return { items, visibleItems: items.filter(item => !dismissed.has(item.key)), dismiss, active: enabled && access === 'granted', toggle, permissionError }
}

export function AttentionControl({ active, toggle }: { active: boolean; toggle: () => void }) {
  return <button className="button notification-toggle" onClick={toggle} aria-pressed={active}
    title={active ? '关闭桌面提醒' : '开启桌面提醒'}>
    {active ? <Bell size={16} /> : <BellOff size={16} />}
    <span>{active ? '桌面提醒已开启' : '开启桌面提醒'}</span>
  </button>
}
