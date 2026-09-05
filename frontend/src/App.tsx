import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  CircleDot,
  FileCheck2,
  FolderOpen,
  History,
  LayoutDashboard,
  Menu,
  Plus,
  Settings2,
  Square,
  X,
} from 'lucide-react'
import type { PublicSettings, RunState } from '../../decision-desk/shared/types.js'
import { STATUS_LABELS } from '../../decision-desk/shared/types.js'
import { api, bootstrap, dateLabel, requestId } from './lib/api.js'
import { isActive } from './lib/board.js'
import { Board } from './components/Board.js'
import { Intake } from './components/Intake.js'
import { Artifacts, RecordView } from './components/Records.js'
import { Activity } from './components/Activity.js'
import { Settings } from './components/Settings.js'
import { Empty, Spinner } from './components/ui.js'
import { ShuffleLabel } from './components/ShuffleLabel.js'

type View = 'board' | 'artifacts' | 'activity' | 'record'
const taskLabel = (run: RunState) => run.title.split(/[，。；;\n]/)[0].slice(0, 24)
const views = [
  { id: 'board' as const, label: '决策看板', icon: LayoutDashboard },
  { id: 'artifacts' as const, label: '成果与验证', icon: FolderOpen },
  { id: 'activity' as const, label: '过程时间线', icon: History },
  { id: 'record' as const, label: '我的判断', icon: FileCheck2 },
]

export default function App() {
  const [runs, setRuns] = useState<RunState[]>([])
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [view, setView] = useState<View>('board')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [connection, setConnection] = useState<'connected' | 'reconnecting'>('connected')
  const [busy, setBusy] = useState(false)
  const [prompt, setPrompt] = useState('')
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const update = useCallback(
    (state: RunState) =>
      setRuns((previous) =>
        [...previous.filter((entry) => entry.id !== state.id), state].sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        ),
      ),
    [],
  )
  const load = useCallback(async () => {
    setError('')
    try {
      const result = await bootstrap()
      setRuns(result.runs)
      setSettings(result.settings)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法连接本地服务。')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    if (!selected) return
    setConnection('reconnecting')
    const events = new EventSource(`/api/runs/${selected}/stream`)
    events.addEventListener('state', (event) => {
      if (selectedRef.current !== selected) return
      update(JSON.parse((event as MessageEvent).data))
      setConnection('connected')
    })
    events.onerror = () => setConnection('reconnecting')
    return () => events.close()
  }, [selected, update])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 4500)
    return () => clearTimeout(timer)
  }, [notice])
  const run = runs.find((entry) => entry.id === selected)
  const select = (id: string | null) => {
    setSelected(id)
    setView('board')
    setMobileOpen(false)
    setError('')
  }
  const perform = async (work: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作未完成。')
    } finally {
      setBusy(false)
    }
  }
  const stop = async () => {
    if (!run) return
    update(await api<RunState>(`/api/runs/${run.id}/stop`, { requestId: requestId() }))
    setNotice('已请求停止，正在收敛执行。')
  }
  const resume = async () => {
    if (!run) return
    if (!settings?.configured) {
      setSettingsOpen(true)
      return
    }
    update(
      await api<RunState>(`/api/runs/${run.id}/resume`, {
        requestId: requestId(),
        revision: run.revision,
      }),
    )
    setNotice('任务已继续')
  }
  const pending = run?.gates.filter((gate) => gate.status === 'pending').length ?? 0
  const create = () =>
    perform(async () => {
      if (!settings?.configured) {
        setSettingsOpen(true)
        return
      }
      const state = await api<RunState>('/api/runs', { prompt, mode: 'live' })
      update(state)
      select(state.id)
      setPrompt('')
      update(await api<RunState>(`/api/runs/${state.id}/grill`, { round: 0 }))
    })

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        跳到主要内容
      </a>
      {mobileOpen && (
        <button
          className="sidebar-scrim"
          aria-label="关闭导航"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside className={`sidebar ${mobileOpen ? 'is-open' : ''}`} aria-label="工作空间导航">
        <button className="brand" onClick={() => select(null)} aria-label="看着办首页">
          <span className="brand-icon">
            <CircleDot size={27} strokeWidth={1.65} />
          </span>
          <span>看着办</span>
        </button>
        <button className="new-task button" onClick={() => select(null)}>
          <Plus size={17} />
          新建任务
        </button>
        <p className="nav-caption">工作空间</p>
        <button className={`nav-item ${!run ? 'selected' : ''}`} onClick={() => select(null)}>
          <LayoutDashboard size={18} />
          任务概览
        </button>
        {run && (
          <>
            <p className="nav-caption current-caption">当前任务</p>
            <nav>
              {views.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  className={`nav-item ${view === id ? 'selected' : ''}`}
                  aria-current={view === id ? 'page' : undefined}
                  onClick={() => {
                    setView(id)
                    setMobileOpen(false)
                  }}
                >
                  <Icon size={18} />
                  {id === 'board' && run.status === 'ready' ? '需求确认' : label}
                  {id === 'board' && pending > 0 && <span className="nav-badge">{pending}</span>}
                </button>
              ))}
            </nav>
          </>
        )}
        <div className="recent-heading">
          <p className="nav-caption">最近任务</p>
          <span>{runs.length}</span>
        </div>
        <div className="recent-list">
          {runs.length ? (
            runs.slice(0, 12).map((entry) => (
              <button
                key={entry.id}
                className={`recent-task ${entry.id === selected ? 'current' : ''}`}
                onClick={() => select(entry.id)}
                title={taskLabel(entry)}
              >
                <span className={`status-dot ${entry.status}`} />
                <span>{taskLabel(entry)}</span>
              </button>
            ))
          ) : (
            <p className="sidebar-empty">暂无任务</p>
          )}
        </div>
        <div className="sidebar-footer">
          <button className="settings-entry" onClick={() => setSettingsOpen(true)}>
            <Settings2 size={18} />
            <span>
              模型与设置<small>{settings?.configured ? '模型已配置' : '连接模型以开始'}</small>
            </span>
            <ChevronRight size={15} />
          </button>
          <div className="local-label">
            <span className="status-dot" />
            本机工作空间
          </div>
        </div>
      </aside>
      <div className="app-content">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="打开导航"
              onClick={() => setMobileOpen(true)}
            >
              <Menu size={20} />
            </button>
            <span>{run ? taskLabel(run) : '任务概览'}</span>
          </div>
          <div className="topbar-actions">
            {run && (
              <span className={`connection ${connection}`}>
                <span className="status-dot" />
                {connection === 'connected' ? '实时同步' : '重新连接中'}
              </span>
            )}
            <button
              className="icon-button"
              aria-label="模型与设置"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2 size={18} />
            </button>
            <span className="avatar" aria-label="本机用户">
              我
            </span>
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button
                className="icon-button"
                aria-label="关闭错误提示"
                onClick={() => setError('')}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {loading ? (
            <div className="loading-state">
              <Spinner />
              <p>正在打开工作空间…</p>
            </div>
          ) : !settings ? (
            <Empty
              icon={<CircleDot />}
              title="本地服务暂时不可用"
              action={
                <button className="button primary" onClick={() => void load()}>
                  重新连接
                </button>
              }
            >
              请确认工作台服务正在运行。
            </Empty>
          ) : !run ? (
            <section className="overview">
              <div className="overview-heading">
                <span className="eyebrow">你的工作空间</span>
                <h1>
                  下一件想做的事，
                  <br />
                  <span>
                    <ShuffleLabel>从这里开始。</ShuffleLabel>
                  </span>
                </h1>
              </div>
              <form
                className="task-composer"
                onSubmit={(event) => {
                  event.preventDefault()
                  void create()
                }}
              >
                <label htmlFor="task-prompt">你想完成什么？</label>
                <textarea
                  id="task-prompt"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  maxLength={6000}
                  placeholder="描述你的想法，以及已经确定的要求…"
                  required
                  minLength={3}
                />
                <div className="composer-bottom">
                  <button className="button primary" disabled={busy || prompt.trim().length < 3}>
                    {busy ? <Spinner /> : <ArrowRight size={16} />}
                    {settings.configured ? '开始澄清需求' : '连接模型并开始'}
                  </button>
                </div>
              </form>

              <div className="section-heading">
                <h2>最近的任务</h2>
                <span className="muted">{runs.length ? `${runs.length} 个任务` : ''}</span>
              </div>
              {runs.length ? (
                <div className="task-list">
                  {runs.map((entry) => (
                    <button className="task-row" key={entry.id} onClick={() => select(entry.id)}>
                      <span className="task-row-icon">
                        <FolderOpen size={21} />
                      </span>
                      <span className="task-row-copy">
                        <strong>{taskLabel(entry)}</strong>
                        <small>
                          {dateLabel(entry.createdAt)}
                          {entry.mode === 'demo' ? ' · 测试' : ''}
                        </small>
                      </span>
                      <span className={`status-label ${entry.status}`}>
                        <span className={`status-dot ${entry.status}`} />
                        {STATUS_LABELS[entry.status]}
                      </span>
                      <ChevronRight size={17} />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="first-task-note">
                  <FolderOpen size={22} />
                  <div>
                    <strong>还没有任务</strong>
                  </div>
                </div>
              )}
            </section>
          ) : (
            <section className="workspace" key={run.id}>
              <div className="workspace-heading">
                <div>
                  <button className="back-link" onClick={() => select(null)}>
                    <ArrowLeft size={14} />
                    所有任务
                  </button>
                  <h1>
                    {run.status === 'ready' && view === 'board'
                      ? '需求确认'
                      : views.find((entry) => entry.id === view)?.label}
                  </h1>
                </div>
                <div className="workspace-status">
                  <span className={`status-label ${run.status}`}>
                    <span className={`status-dot ${run.status}`} />
                    {STATUS_LABELS[run.status]}
                  </span>
                  {['interrupted', 'stopped', 'error'].includes(run.status) && (
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={() => void perform(resume)}
                    >
                      {busy ? <Spinner /> : <ArrowRight size={15} />}继续任务
                    </button>
                  )}
                  {isActive(run) && (
                    <button
                      className="button secondary stop-button"
                      disabled={busy || run.status === 'stopping'}
                      onClick={() => void perform(stop)}
                    >
                      {run.status === 'stopping' ? <Spinner /> : <Square size={13} />}停止任务
                    </button>
                  )}
                </div>
              </div>
              {connection === 'reconnecting' && (
                <div className="inline-note" role="status">
                  正在重新连接。当前显示最后同步的记录。
                </div>
              )}
              {run.error && (
                <div className="error-banner" role="status">
                  {run.error}
                </div>
              )}
              {run.status === 'ready' && view === 'board' ? (
                <Intake run={run} update={update} notify={setNotice} />
              ) : view === 'board' ? (
                <Board run={run} update={update} stop={stop} notify={setNotice} />
              ) : view === 'artifacts' ? (
                <Artifacts run={run} />
              ) : view === 'activity' ? (
                <Activity run={run} />
              ) : (
                <RecordView
                  run={run}
                  update={update}
                  onDeleted={() => {
                    setRuns((previous) => previous.filter((entry) => entry.id !== run.id))
                    select(null)
                    setNotice('任务数据已删除。')
                  }}
                />
              )}
            </section>
          )}
        </main>
      </div>
      {notice && (
        <div className="toast" role="status">
          <Check size={17} />
          {notice}
        </div>
      )}
      {settingsOpen && settings && (
        <Settings settings={settings} onSave={setSettings} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  )
}
