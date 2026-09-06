import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Code2,
  Eye,
  FileText,
  Fingerprint,
  GitBranch,
  Layers3,
  Loader2,
  MessageSquareText,
  Play,
  Plus,
  Radio,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Square,
  Terminal,
  X,
  AlertTriangle,
  BookOpen,
  Maximize2,
  Minimize2,
  Lightbulb,
} from 'lucide-react'
import type {
  Decision,
  ModelConfig,
  PublicSettings,
  RunState,
  Step,
  VerdictInput,
  AdditionInput,
  Intervention,
} from '../shared/types.js'
import { DEMO_PROMPT, STATUS_LABELS } from '../shared/types.js'

async function api<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    ...(body !== undefined
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? '请求没有完成')
  return data as T
}
const time = (date: string) =>
  new Date(date).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
const shortId = (id: string) => id.slice(0, 6).toUpperCase()
const stepStatus: Record<Step['status'], string> = {
  reviewing: '检查中',
  waiting: '等待你',
  executing: '执行中',
  done: '已执行',
  denied: '已拦停',
  failed: '执行失败',
  cancelled: '已取消',
}
const progressLabel = {
  recorded: '已记录',
  delivered: '已进入执行上下文',
  acted: '已产生后续改动',
  verified: '对应静态检查已通过',
  superseded: '已被后续要求取代',
}
const actionLabel = {
  correct: '调整做法',
  enforce: '要求按原约定改正',
  'allow-once': '仅本次允许',
  acknowledge: '认可选择',
  stop: '停止任务',
  followup: '补充要求',
}

export default function App() {
  const [runs, setRuns] = useState<RunState[]>([]),
    [selected, setSelected] = useState<string | null>(null)
  const [settings, setSettings] = useState<PublicSettings | null>(null),
    [settingsOpen, setSettingsOpen] = useState(false)
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'timeline' | 'preview' | 'summary'>('timeline'),
    [connection, setConnection] = useState('connected')
  const [focusedDecision, setFocusedDecision] = useState<string | null>(null)
  const update = useCallback(
    (state: RunState) =>
      setRuns((prev) =>
        [state, ...prev.filter((s) => s.id !== state.id)].sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        ),
      ),
    [],
  )
  useEffect(() => {
    api<{ runs: RunState[]; settings: PublicSettings }>('/api/bootstrap')
      .then((data) => {
        setRuns(data.runs)
        setSettings(data.settings)
        setSelected(data.runs[0]?.id ?? null)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => {
    if (!selected) return
    setFocusedDecision(null)
    setConnection('connected')
    const stream = new EventSource(`/api/runs/${selected}/stream`)
    stream.addEventListener('state', (e) => {
      update(JSON.parse((e as MessageEvent).data))
      setConnection('connected')
    })
    stream.onerror = () => setConnection('reconnecting')
    return () => stream.close()
  }, [selected, update])
  const run = runs.find((r) => r.id === selected)
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作没有完成')
    } finally {
      setBusy(false)
    }
  }
  const create = (prompt: string, mode: 'demo' | 'live') =>
    perform(async () => {
      const state = await api<RunState>('/api/runs', { prompt, mode })
      update(state)
      setSelected(state.id)
      setTab('timeline')
    })
  const start = (constraints: string[]) =>
    perform(async () => {
      if (run) update(await api<RunState>(`/api/runs/${run.id}/start`, { constraints }))
    })
  const verdict = async (body: Omit<VerdictInput, 'requestId' | 'revision'>) => {
    if (!run) return
    await api(`/api/runs/${run.id}/verdict`, {
      ...body,
      requestId: crypto.randomUUID(),
      revision: run.revision,
    })
    update(await api<RunState>(`/api/runs/${run.id}`))
  }
  const pending = run?.gates.find((g) => g.status === 'pending')
  useEffect(() => {
    if (pending) {
      setFocusedDecision(pending.decisionId)
      setTab('timeline')
    }
  }, [pending?.id])
  const decision =
    run?.decisions.find((d) => d.id === focusedDecision) ??
    run?.decisions.find((d) => d.id === pending?.decisionId) ??
    run?.decisions.at(-1)
  const active = run && ['running', 'waiting', 'stopping'].includes(run.status)

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault()
            setSelected(null)
          }}
          aria-label="在场首页"
        >
          <span className="brand-mark">
            <Layers3 size={22} strokeWidth={2.2} />
          </span>
          <span>
            在场<span className="brand-sub">DECISION DESK</span>
          </span>
          <span className="beta">BETA</span>
        </a>
        <button
          className="new-task"
          onClick={() => {
            setSelected(null)
            setTab('timeline')
            setError('')
          }}
        >
          <Plus size={17} /> 开始一次协作 <span>↗</span>
        </button>
        <div className="nav-label">工作空间</div>
        <button
          className={`nav-item ${tab === 'timeline' ? 'active' : ''}`}
          onClick={() => setTab('timeline')}
        >
          <GitBranch size={17} /> 决策时间线 <span className="nav-dot" />
        </button>
        <button
          className={`nav-item ${tab === 'preview' ? 'active' : ''}`}
          onClick={() => setTab('preview')}
        >
          <Eye size={17} /> 成果展示 <span className="nav-dot" />
        </button>
        <button
          className={`nav-item ${tab === 'summary' ? 'active' : ''}`}
          onClick={() => setTab('summary')}
        >
          <Fingerprint size={17} /> 我的判断{' '}
          {run && <span className="nav-count">{run.interventions.length}</span>}
        </button>
        <div className="nav-label recent-label">
          本机任务 <span>{runs.length.toString().padStart(2, '0')}</span>
        </div>
        <div className="history">
          {runs.length === 0 ? (
            <p className="empty-history">
              第一段协作，
              <br />
              从一个小想法开始。
            </p>
          ) : (
            runs.map((r) => (
              <button
                key={r.id}
                className={`history-item ${r.id === selected ? 'selected' : ''}`}
                onClick={() => {
                  setSelected(r.id)
                  setTab('timeline')
                }}
              >
                <span className={`history-status ${r.status}`} />
                <span>
                  <strong>{r.title}</strong>
                  <small>
                    {r.mode === 'demo' ? '交互演示' : '真实运行'} · {time(r.createdAt)}
                  </small>
                </span>
              </button>
            ))
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="local-note">
            <ShieldCheck size={17} />
            <div>
              过程留在这台电脑<small>你的要求，你的判断，有据可查。</small>
            </div>
          </div>
          <button className="profile" onClick={() => setSettingsOpen(true)}>
            <span className="avatar">我</span>
            <span>
              我的工作台<small>{settings?.configured ? '模型已配置' : '演示模式可用'}</small>
            </span>
            <Settings2 size={16} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            工作空间 <ChevronRight size={13} />
            <strong>{run ? `协作 ${shortId(run.id)}` : '新的开始'}</strong>
          </div>
          <div className="topbar-right">
            <span className="care-label">BUILD WITH CARE</span>
            <button
              className="icon-button"
              title="模型设置"
              aria-label="模型设置"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2 size={18} />
            </button>
            <span className="avatar small">我</span>
          </div>
        </header>
        <main>
          {error && (
            <div className="error-banner" role="alert">
              <AlertTriangle size={17} />
              <span>{error}</span>
              <button className="icon-button" aria-label="关闭提示" onClick={() => setError('')}>
                <X size={15} />
              </button>
            </div>
          )}
          {connection !== 'connected' && run && (
            <div className="error-banner">
              <Radio size={16} />
              <span>连接已中断，正在重连。未处理的调用不会自动放行。</span>
              <button className="text-button" onClick={() => window.location.reload()}>
                刷新页面
              </button>
            </div>
          )}
          {loading ? (
            <div className="loading-screen">
              <Loader2 className="spin" /> 正在打开工作台
            </div>
          ) : !run ? (
            <Landing
              busy={busy}
              configured={!!settings?.configured}
              onCreate={create}
              onSettings={() => setSettingsOpen(true)}
            />
          ) : (
            <>
              <div className="workspace-heading">
                <div>
                  <div className="eyebrow">
                    <span className="eyebrow-line" /> 人与 AGENT，一起把事做成
                  </div>
                  <h1>
                    {tab === 'summary'
                      ? '每一次判断，都有来处。'
                      : tab === 'preview'
                        ? '把成果展开，亲自试一试。'
                        : '看清过程，把握方向。'}
                  </h1>
                  <p className="heading-description">
                    {tab === 'summary'
                      ? '回到你拍板的那些时刻，看见它们带来了什么。'
                      : tab === 'preview'
                        ? '完整查看生成页面，边体验，边补充你的下一步想法。'
                        : '重要的选择浮出来，确定的事情继续向前。'}
                  </p>
                </div>
                <div className="workspace-actions">
                  <span className={`status-pill ${run.status}`}>
                    <span className="status-dot" />
                    {STATUS_LABELS[run.status]}
                  </span>
                  {active && (
                    <button
                      className="button stop-button"
                      disabled={busy || run.status === 'stopping'}
                      onClick={() =>
                        perform(async () =>
                          update(
                            await api<RunState>(`/api/runs/${run.id}/stop`, {
                              requestId: crypto.randomUUID(),
                            }),
                          ),
                        )
                      }
                    >
                      <Square size={13} /> 停止任务
                    </button>
                  )}
                </div>
              </div>
              <div className={`mode-banner ${run.mode}`}>
                <span>
                  {run.mode === 'demo' ? <Play size={13} /> : <Radio size={14} />}
                  <strong>{run.mode === 'demo' ? '交互演示' : '真实模型运行'}</strong>
                </span>
                <p>
                  {run.mode === 'demo'
                    ? '固定演示执行器与规则审查 · dsh 实际执行、文件实际写入 · 不代表真实模型效果'
                    : `${run.workerLabel} 执行 · ${run.reviewerLabel} 独立审查`}
                </p>
                <span className="version-label">{run.runtime}</span>
              </div>
              {run.status === 'ready' ? (
                <Baseline run={run} busy={busy} onStart={start} />
              ) : (
                <>
                  <Stats run={run} />
                  <div className="workspace-tabs">
                    <button
                      className={`tab-timeline ${tab === 'timeline' ? 'active' : ''}`}
                      onClick={() => setTab('timeline')}
                    >
                      <GitBranch size={15} /> 协作时间线
                    </button>
                    <button
                      className={`tab-preview ${tab === 'preview' ? 'active' : ''}`}
                      onClick={() => setTab('preview')}
                    >
                      <Eye size={15} /> 成果展示
                    </button>
                    <button
                      className={`tab-summary ${tab === 'summary' ? 'active' : ''}`}
                      onClick={() => setTab('summary')}
                    >
                      <Fingerprint size={15} /> 判断与复盘
                    </button>
                    <span className="tab-meta">
                      {run.steps.length} 个动作 · 约束 v{run.revision}
                    </span>
                  </div>
                  <AdditionComposer key={run.id} run={run} update={update} />
                  {tab === 'preview' ? (
                    <Preview key={run.id} run={run} />
                  ) : tab === 'summary' ? (
                    <Summary
                      run={run}
                      update={update}
                      reportError={setError}
                      onViewStep={(id) => {
                        setTab('timeline')
                        setTimeout(
                          () =>
                            document
                              .getElementById(`step-${id}`)
                              ?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
                          50,
                        )
                      }}
                    />
                  ) : (
                    <div className="workspace-grid">
                      <section className="timeline-column">
                        <ConstraintStrip run={run} />
                        <div className="timeline-section-title">
                          <h2>事情正在这样推进</h2>
                          <span>
                            <span className="tiny-dot" /> 实时记录
                          </span>
                        </div>
                        <div className="timeline">
                          <div className="timeline-origin">
                            <span className="origin-dot">
                              <MessageSquareText size={14} />
                            </span>
                            <div>
                              <strong>从你的想法开始</strong>
                              <time>{time(run.createdAt)}</time>
                              <p>{run.prompt}</p>
                            </div>
                          </div>
                          <TimelineEvents run={run} onFocus={setFocusedDecision} />
                          {run.steps.length === 0 && (
                            <div className="timeline-loading">
                              <Loader2 size={18} className="spin" />
                              <span>正在连接执行器，准备第一个动作…</span>
                            </div>
                          )}
                          {run.error && (
                            <div className="inline-error">
                              <AlertTriangle size={16} />
                              {run.error}
                            </div>
                          )}
                          {run.status === 'completed' && (
                            <div className="timeline-end">
                              <Check size={13} /> 本轮执行已结束
                              <button className="text-button" onClick={() => setTab('preview')}>
                                展开成果，开始验收 <ArrowUpRight size={13} />
                              </button>
                            </div>
                          )}
                        </div>
                      </section>
                      <aside className="context-column">
                        <DecisionPanel
                          key={decision?.id ?? 'empty'}
                          decision={decision}
                          run={run}
                          onVerdict={verdict}
                          reportError={setError}
                        />
                        <button className="result-entry" onClick={() => setTab('preview')}>
                          <Eye size={20} />
                          <span>
                            <strong>展开成果展示</strong>
                            <small>
                              {run.files.length
                                ? '在完整工作区查看和操作页面'
                                : '第一个页面生成后即可查看'}
                            </small>
                          </span>
                          <ArrowUpRight size={18} />
                        </button>
                        <VerificationPanel run={run} />
                      </aside>
                    </div>
                  )}
                </>
              )}
            </>
          )}
          <footer className="page-footer">
            <span>
              <span className="footer-mark">✳</span> 让人始终在场。
            </span>
            <span>看得懂 · 管得住 · 留得下</span>
          </footer>
        </main>
      </div>
      {settingsOpen && settings && (
        <SettingsDialog
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onSave={(s) => setSettings(s)}
        />
      )}
    </div>
  )
}

function Landing({
  busy,
  configured,
  onCreate,
  onSettings,
}: {
  busy: boolean
  configured: boolean
  onCreate: (p: string, m: 'demo' | 'live') => void
  onSettings: () => void
}) {
  const [prompt, setPrompt] = useState(DEMO_PROMPT),
    [mode, setMode] = useState<'demo' | 'live'>('demo')
  return (
    <div className="landing">
      <div className="landing-copy">
        <div className="eyebrow">
          <span className="eyebrow-line" /> 一个人的想法，一起完成
        </div>
        <h1>
          让每一个关键决定，
          <br />
          都有你在场<span className="mint-period">。</span>
        </h1>
        <p>
          Agent 负责动手，你来把握方向。
          <br />
          看见它的选择，在需要的时候，改一句就好。
        </p>
        <div className="principles">
          <span>
            <Eye size={15} /> 看见隐性的选择
          </span>
          <span>
            <ShieldCheck size={15} /> 冲突前停下来
          </span>
          <span>
            <Fingerprint size={15} /> 留下你的判断
          </span>
        </div>
      </div>
      <div className="landing-illustration" aria-hidden="true">
        <span className="illustration-kicker">A SMALL MOMENT. A BIG DIFFERENCE.</span>
        <div className="mini-card human">
          <span className="mini-icon">
            <MessageSquareText size={17} />
          </span>
          <div>
            <small>你的要求</small>
            <strong>刷新后，报名信息清空。</strong>
          </div>
          <Check size={16} />
        </div>
        <div className="connector">
          <span />
        </div>
        <div className="mini-card agent">
          <span className="mini-icon">
            <GitBranch size={17} />
          </span>
          <div>
            <small>Agent 准备做</small>
            <strong>保存信息，供下次继续使用。</strong>
          </div>
          <span className="mini-alert">!</span>
        </div>
        <div className="intervention-float">
          <Fingerprint size={18} />
          <span>等一下，这里由我决定。</span>
          <ArrowUpRight size={16} />
        </div>
        <span className="illustration-index">01 / KEEP HUMAN IN THE LOOP</span>
      </div>
      <section className="composer">
        <div className="composer-title">
          <h2>这次，想一起做点什么？</h2>
          <div className="mode-switch">
            <button
              className={mode === 'demo' ? 'active' : ''}
              onClick={() => {
                setMode('demo')
                setPrompt(DEMO_PROMPT)
              }}
            >
              <Play size={12} /> 先体验一次
            </button>
            <button className={mode === 'live' ? 'active' : ''} onClick={() => setMode('live')}>
              <Radio size={13} /> 真实运行
            </button>
          </div>
        </div>
        <textarea
          aria-label="描述任务"
          readOnly={mode === 'demo'}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="说清想做什么，以及你已经确定的要求…"
          maxLength={6000}
        />
        <div className="composer-bottom">
          <span>
            <CircleHelp size={14} />
            {mode === 'demo'
              ? '演示固定的存储纠正流程；会实际生成一个小网页。'
              : configured
                ? '将先整理你的要求，确认后才开始执行。'
                : '真实运行需要配置执行模型和独立审查模型。'}
          </span>
          {mode === 'live' && !configured ? (
            <button className="button primary" onClick={onSettings}>
              配置模型 <ArrowRight size={16} />
            </button>
          ) : (
            <button
              className="button primary"
              disabled={busy || prompt.trim().length < 3}
              onClick={() => onCreate(mode === 'demo' ? DEMO_PROMPT : prompt, mode)}
            >
              {busy ? <Loader2 className="spin" size={16} /> : <ArrowRight size={16} />} 整理需求
            </button>
          )}
        </div>
      </section>
      <div className="landing-notes">
        <div>
          <span>01</span>
          <h3>确定的，照着做</h3>
          <p>
            从你的原话提取约束，
            <br />
            不偷偷替你加要求。
          </p>
        </div>
        <div>
          <span>02</span>
          <h3>没确定的，看得见</h3>
          <p>
            重要选择安静地浮出来，
            <br />
            冲突才需要你拍板。
          </p>
        </div>
        <div>
          <span>03</span>
          <h3>你改的，留得下</h3>
          <p>
            判断关联后续行动与检查，
            <br />
            随时回到那一刻。
          </p>
        </div>
      </div>
    </div>
  )
}

function Baseline({
  run,
  busy,
  onStart,
}: {
  run: RunState
  busy: boolean
  onStart: (c: string[]) => void
}) {
  const [constraints, setConstraints] = useState(run.constraints.map((c) => c.text))
  return (
    <section className="baseline panel">
      <div className="baseline-head">
        <span className="section-symbol">
          <MessageSquareText size={22} />
        </span>
        <div>
          <div className="eyebrow">开始之前，只对齐重要的事</div>
          <h2>这些要求，我们就照着做。</h2>
          <p>下面来自你的原话。可以修改或补充，不需要写一份长计划。</p>
        </div>
      </div>
      <div className="original-request">
        <small>你的原话</small>
        <p>{run.prompt}</p>
      </div>
      <div className="constraint-editor">
        {constraints.map((text, i) => (
          <div className="constraint-edit-row" key={i}>
            <span>{String(i + 1).padStart(2, '0')}</span>
            <input
              aria-label={`约束 ${i + 1}`}
              value={text}
              onChange={(e) =>
                setConstraints((prev) => prev.map((c, n) => (n === i ? e.target.value : c)))
              }
            />
            <button
              className="icon-button"
              aria-label={`移除约束 ${i + 1}`}
              disabled={constraints.length <= 1}
              onClick={() => setConstraints((prev) => prev.filter((_, n) => n !== i))}
            >
              <X size={15} />
            </button>
          </div>
        ))}
      </div>
      <button
        className="text-button add-constraint"
        disabled={constraints.length >= 8}
        onClick={() => setConstraints((p) => [...p, ''])}
      >
        <Plus size={14} /> 补充一条要求
      </button>
      <div className="baseline-footer">
        <span>
          <ShieldCheck size={16} /> 你确认后，Agent 才开始执行。
        </span>
        <button
          className="button primary"
          disabled={busy || constraints.some((c) => !c.trim())}
          onClick={() => onStart(constraints)}
        >
          {busy ? <Loader2 className="spin" size={16} /> : <Play size={15} />} 确认，开始协作
        </button>
      </div>
    </section>
  )
}
function Stats({ run }: { run: RunState }) {
  const items = [
    { label: '重要决策', value: run.decisions.length, icon: GitBranch, note: 'Agent 作出的选择' },
    {
      label: '等待拍板',
      value: run.gates.filter((g) => g.status === 'pending').length,
      icon: Clock3,
      note: '需要你看一眼',
      attention: true,
    },
    {
      label: '你的干预',
      value: run.interventions.filter((i) => ['correct', 'enforce', 'followup'].includes(i.action))
        .length,
      icon: Fingerprint,
      note: '把方向握在手里',
    },
    {
      label: '有效检查',
      value: run.verifications.filter((v) => v.passed && !v.stale).length,
      icon: ShieldCheck,
      note: '每一项都有证据',
    },
  ]
  return (
    <div className="stats">
      {items.map((item) => (
        <div className={`stat ${item.attention && item.value ? 'attention' : ''}`} key={item.label}>
          <div>
            <span>{item.label}</span>
            <item.icon size={16} />
          </div>
          <strong>{String(item.value).padStart(2, '0')}</strong>
          <small>{item.note}</small>
        </div>
      ))}
    </div>
  )
}
function ConstraintStrip({ run }: { run: RunState }) {
  return (
    <details className="constraint-strip">
      <summary>
        <span>
          <ShieldCheck size={15} /> 当前有效约束 <b>v{run.revision}</b>
        </span>
        <span>
          {run.constraints.filter((c) => c.active).length} 条 <ChevronDown size={14} />
        </span>
      </summary>
      <ol>
        {run.constraints
          .filter((c) => c.active)
          .map((c) => (
            <li key={c.id}>
              {c.text}
              <small>{c.source === '人的本次纠正' ? '来自你的纠正' : '已确认'}</small>
            </li>
          ))}
      </ol>
    </details>
  )
}
function AdditionComposer({ run, update }: { run: RunState; update: (s: RunState) => void }) {
  const [text, setText] = useState(''),
    [kind, setKind] = useState<AdditionInput['kind']>('requirement')
  const [replace, setReplace] = useState(''),
    [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(''),
    [error, setError] = useState('')
  const requestId = useRef(crypto.randomUUID())
  const change = () => {
    requestId.current = crypto.randomUUID()
    setMessage('')
    setError('')
  }
  return (
    <form
      className={`addition-composer ${kind}`}
      aria-label="追加要求与想法"
      onSubmit={async (e) => {
        e.preventDefault()
        if (!text.trim() || busy) return
        setBusy(true)
        setError('')
        setMessage('')
        try {
          const next = await api<RunState>(`/api/runs/${run.id}/additions`, {
            requestId: requestId.current,
            revision: run.revision,
            kind,
            text,
            ...(kind === 'requirement' && replace ? { replaceConstraintId: replace } : {}),
          })
          update(next)
          setText('')
          setReplace('')
          requestId.current = crypto.randomUUID()
          setMessage(
            kind === 'requirement'
              ? '新要求已加入，Agent 将按更新后的要求继续。'
              : next.status === 'waiting'
                ? '想法已保存；当前冲突仍需你拍板，之后交给 Agent 回应。'
                : '想法已送达，先讨论可行性，现有要求保持有效。',
          )
        } catch (e) {
          setError(e instanceof Error ? e.message : '补充未发送，请重试')
        } finally {
          setBusy(false)
        }
      }}
    >
      <div className="addition-heading">
        <div>
          <MessageSquareText size={19} />
          <strong>接下来，你还想补充什么？</strong>
        </div>
        <div className="addition-kinds" aria-label="补充内容类型">
          <button
            type="button"
            aria-pressed={kind === 'requirement'}
            disabled={busy}
            className={kind === 'requirement' ? 'active' : ''}
            onClick={() => {
              setKind('requirement')
              change()
            }}
          >
            <Plus size={14} />
            新要求
          </button>
          <button
            type="button"
            aria-pressed={kind === 'idea'}
            disabled={busy}
            className={kind === 'idea' ? 'active' : ''}
            onClick={() => {
              setKind('idea')
              change()
            }}
          >
            <Lightbulb size={14} />
            新想法
          </button>
        </div>
      </div>
      <label className="sr-only" htmlFor="addition-text">
        补充新的要求或想法
      </label>
      <textarea
        id="addition-text"
        value={text}
        disabled={busy || run.status === 'stopping'}
        onChange={(e) => {
          setText(e.target.value)
          change()
        }}
        maxLength={3000}
        rows={2}
        placeholder={
          kind === 'requirement'
            ? '例如：报名名额改为 30 人。也可以补充页面、交互或内容上的新要求…'
            : '例如：我在想，要不要给第一次参加的人多一点引导？先聊聊可行性…'
        }
      />
      <div className="addition-footer">
        <div>
          <p>
            {kind === 'requirement'
              ? '更新有效要求；已完成的内容通过后续修补调整。'
              : '先作为参考讨论，不自动改动页面或覆盖要求。'}
          </p>
          {kind === 'requirement' && (
            <details>
              <summary>需要替换已有要求？</summary>
              <label>
                要求更新方式
                <select
                  value={replace}
                  disabled={busy}
                  onChange={(e) => {
                    setReplace(e.target.value)
                    change()
                  }}
                >
                  <option value="">追加一条新要求</option>
                  {run.constraints
                    .filter((c) => c.active)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        替换：{c.text}
                      </option>
                    ))}
                </select>
              </label>
            </details>
          )}
          {run.mode === 'demo' && (
            <small>演示支持存储与名额调整；其他内容会记录，需真实模型处理。</small>
          )}
        </div>
        <button
          className="button primary"
          disabled={busy || !text.trim() || run.status === 'stopping'}
        >
          {busy ? <Loader2 size={15} className="spin" /> : <ArrowRight size={15} />}{' '}
          {['running', 'waiting'].includes(run.status) ? '发送补充' : '追加并继续'}
        </button>
      </div>
      {message && (
        <p className="addition-success" role="status">
          <Check size={14} />
          {message}
        </p>
      )}
      {error && (
        <p className="addition-error" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}

const eventTypes = [
  { id: 'all', label: '全部事件' },
  { id: 'choice', label: '重要选择' },
  { id: 'conflict', label: '约束冲突' },
  { id: 'uncertain', label: '待核对' },
  { id: 'execution', label: '执行动作' },
  { id: 'verification', label: '验证结果' },
  { id: 'human', label: '人的补充' },
] as const
function stepKind(step: Step) {
  return step.review?.classification === 'conflict' || step.review?.classification === 'uncertain'
    ? step.review.classification
    : step.tool === 'verify_app'
      ? 'verification'
      : (step.review?.classification ?? 'execution')
}
function TimelineEvents({ run, onFocus }: { run: RunState; onFocus: (id: string) => void }) {
  const [filter, setFilter] = useState('all')
  const pendingId = run.gates.find((g) => g.status === 'pending')?.id
  useEffect(() => {
    setFilter('all')
  }, [run.id, pendingId])
  const entries = [
    ...run.steps.map((step, index) => ({
      id: step.id,
      at: step.createdAt,
      kind: stepKind(step),
      node: <StepCard step={step} index={index} run={run} onFocus={onFocus} />,
    })),
    ...run.interventions.map((i) => ({
      id: i.id,
      at: i.createdAt,
      kind: 'human',
      node: <HumanEvent intervention={i} />,
    })),
    ...run.messages
      .filter((m) => m.role === 'agent')
      .map((m) => ({
        id: m.id,
        at: m.at,
        kind: 'execution',
        node: (
          <div className="agent-note">
            <CheckCheck size={16} />
            <p>{m.text}</p>
          </div>
        ),
      })),
  ].sort((a, b) => a.at.localeCompare(b.at))
  const visible = entries.filter((e) => filter === 'all' || e.kind === filter)
  return (
    <>
      <div className="event-filters" aria-label="按事件类型筛选">
        {eventTypes.map((type) => (
          <button
            key={type.id}
            className={`event-filter ${type.id} ${filter === type.id ? 'active' : ''}`}
            aria-pressed={filter === type.id}
            onClick={() => setFilter(type.id)}
          >
            <span className="event-dot" />
            {type.label}
            <b>
              {type.id === 'all'
                ? entries.length
                : entries.filter((e) => e.kind === type.id).length}
            </b>
          </button>
        ))}
      </div>
      {visible.map((e) => (
        <div key={e.id}>{e.node}</div>
      ))}
      {!visible.length && <p className="empty-filter">暂时没有这类事件。</p>}
    </>
  )
}
function HumanEvent({ intervention: i }: { intervention: Intervention }) {
  return (
    <article className={`human-event ${i.additionKind ?? ''}`}>
      <div className="human-event-heading">
        <span>
          {i.additionKind === 'idea' ? <Lightbulb size={15} /> : <MessageSquareText size={15} />}{' '}
          {i.action === 'followup'
            ? i.additionKind === 'idea'
              ? '你补充了一个想法'
              : '你追加了新要求'
            : actionLabel[i.action]}
        </span>
        <time>{time(i.createdAt)}</time>
      </div>
      <p>{i.text}</p>
      <footer>
        <span>{progressLabel[i.progress]}</span>
        <span>{i.additionKind === 'idea' ? '参考想法 · 未修改约束' : `要求 v${i.toRevision}`}</span>
      </footer>
    </article>
  )
}

function StepCard({
  step,
  index,
  run,
  onFocus,
}: {
  step: Step
  index: number
  run: RunState
  onFocus: (id: string) => void
}) {
  const kind = step.review?.classification,
    active = ['reviewing', 'executing'].includes(step.status)
  const sources =
    step.review?.constraintIds
      .map((id) => run.constraints.find((c) => c.id === id)?.text)
      .filter(Boolean) ?? []
  return (
    <article id={`step-${step.id}`} className={`step-row ${stepKind(step)} ${step.status}`}>
      <div className={`step-number ${step.status}`}>
        {active ? (
          <Loader2 size={14} className="spin" />
        ) : step.status === 'done' ? (
          <Check size={14} />
        ) : (
          String(index + 1).padStart(2, '0')
        )}
      </div>
      <div className="step-card">
        <div className="step-card-top">
          <span className="step-kicker">
            {step.tool === 'verify_app'
              ? '验证结果'
              : kind === 'conflict'
                ? '发现约束冲突'
                : kind === 'choice'
                  ? '一个重要选择'
                  : kind === 'uncertain'
                    ? '等待人工核对'
                    : '执行步骤'}
            <time>{time(step.createdAt)}</time>
          </span>
          <span className={`step-status ${step.status}`}>{stepStatus[step.status]}</span>
        </div>
        <h3>{step.review?.title ?? '正在核对这个动作…'}</h3>
        <div className="accounting">
          <div>
            <small>
              <MessageSquareText size={11} /> 你的要求
            </small>
            <p>
              {sources.length
                ? sources.join('；')
                : kind === 'choice'
                  ? '你没有限定这里的具体做法。'
                  : run.prompt}
            </p>
          </div>
          <div>
            <small>
              <GitBranch size={11} />{' '}
              {['reviewing', 'waiting'].includes(step.status)
                ? 'Agent 准备做'
                : step.status === 'denied'
                  ? '被拦停的提案'
                  : 'Agent 的行动'}
            </small>
            <p>{step.review?.summary ?? String(step.args.intent ?? step.tool)}</p>
          </div>
        </div>
        {step.review?.impact && (
          <div className="impact-line">
            <CircleHelp size={13} />
            <span>{step.review.impact}</span>
          </div>
        )}
        <div className="step-bottom">
          <span className="file-tag">
            <FileText size={12} />
            {String(step.args.path ?? step.tool)}
          </span>
          {step.decisionId && (
            <button className="text-button" onClick={() => onFocus(step.decisionId!)}>
              {step.status === 'waiting' ? '查看并拍板' : '查看这个决定'}
              <ArrowUpRight size={12} />
            </button>
          )}
        </div>
        <details className="evidence">
          <summary>
            <Code2 size={12} /> 查看执行证据 <ChevronDown size={12} />
          </summary>
          <div className="evidence-body">
            <small>工具参数 · 约束 v{step.revision}</small>
            <pre>{JSON.stringify(step.args, null, 2)}</pre>
            {step.review?.evidence && (
              <>
                <small>
                  审查依据 ·{' '}
                  {step.review.source === 'demo-rule'
                    ? '演示规则'
                    : step.review.source === 'system'
                      ? '固定检查'
                      : '异源模型'}
                </small>
                <pre>{step.review.evidence}</pre>
              </>
            )}
            {step.result && (
              <>
                <small>实际工具结果</small>
                <pre>{step.result}</pre>
              </>
            )}
          </div>
        </details>
      </div>
    </article>
  )
}

function DecisionPanel({
  decision,
  run,
  onVerdict,
  reportError,
}: {
  decision?: Decision
  run: RunState
  onVerdict: (body: Omit<VerdictInput, 'requestId' | 'revision'>) => Promise<void>
  reportError: (s: string) => void
}) {
  const [editing, setEditing] = useState(false),
    [text, setText] = useState(''),
    [busy, setBusy] = useState(false),
    [replace, setReplace] = useState('')
  const gate = run.gates.find((g) => g.id === decision?.gateId && g.status === 'pending')
  const disabled = busy || ['stopped', 'stopping', 'error', 'interrupted'].includes(run.status)
  const submit = async (action: VerdictInput['action']) => {
    if (!decision) return
    setBusy(true)
    reportError('')
    try {
      await onVerdict({
        decisionId: decision.id,
        ...(gate ? { gateId: gate.id } : {}),
        action,
        ...(action === 'correct'
          ? { text, ...(replace ? { replaceConstraintId: replace } : {}) }
          : {}),
      })
      setEditing(false)
      setText('')
    } catch (e) {
      reportError(e instanceof Error ? e.message : '操作未完成')
    } finally {
      setBusy(false)
    }
  }
  if (!decision)
    return (
      <section className="panel decision-empty">
        <span className="empty-orbit">
          <Eye size={24} />
        </span>
        <h3>重要选择，会在这里出现</h3>
        <p>
          确定的事情继续推进。
          <br />
          需要你时，我们再停下来。
        </p>
        <div>
          <span className="tiny-dot" /> 正在留意关键决定
        </div>
      </section>
    )
  return (
    <section className={`panel decision-panel ${gate ? 'needs-human' : ''}`}>
      <div className="panel-eyebrow">
        <span>
          {gate ? <Clock3 size={14} /> : <GitBranch size={14} />}{' '}
          {gate ? '需要你的一次判断' : '这个选择，你也可以调整'}
        </span>
        <span className="decision-counter">#{run.decisions.indexOf(decision) + 1}</span>
      </div>
      <h2>{decision.review.title}</h2>
      <p className="decision-summary">{decision.review.summary}</p>
      {gate && (
        <div className="hold-note">
          <span className="hold-indicator" /> 这一步尚未执行，正在等你。
        </div>
      )}
      {decision.humanStatus !== 'unreviewed' && (
        <div className="resolved-note">
          <Check size={14} />
          {decision.humanStatus === 'corrected'
            ? '你已调整这项决定'
            : decision.humanStatus === 'acknowledged'
              ? '你已明确认可'
              : '你仅允许了当时那次调用'}
        </div>
      )}
      {decision.review.constraintIds.length > 0 && (
        <div className="quoted-constraint">
          <span>相关的人类要求</span>
          {decision.review.constraintIds.map((id) => (
            <p key={id}>“{run.constraints.find((c) => c.id === id)?.text}”</p>
          ))}
        </div>
      )}
      {!editing ? (
        <>
          <div className="decision-actions">
            {gate && (
              <button
                className="button primary full"
                disabled={disabled}
                onClick={() => submit('enforce')}
              >
                {busy ? <Loader2 size={15} className="spin" /> : <ArrowRight size={15} />}{' '}
                按原要求改正
              </button>
            )}
            <button className="button full" disabled={disabled} onClick={() => setEditing(true)}>
              <MessageSquareText size={15} /> {gate ? '我来写一句纠正' : '调整后续做法'}
            </button>
            {gate ? (
              <button
                className="text-button allow-once"
                disabled={disabled}
                onClick={() => submit('allow-once')}
              >
                我已了解，仅本次允许 <ChevronRight size={13} />
              </button>
            ) : (
              decision.humanStatus === 'unreviewed' && (
                <button
                  className="text-button allow-once"
                  disabled={disabled}
                  onClick={() => submit('acknowledge')}
                >
                  <Check size={13} /> 认可这个选择
                </button>
              )
            )}
          </div>
          {decision.review.options.length > 0 && (
            <div className="suggestions">
              <small>也可以从一句话开始</small>
              {decision.review.options.map((option) => (
                <button
                  key={option}
                  disabled={disabled}
                  onClick={() => {
                    setText(option)
                    setEditing(true)
                  }}
                >
                  {option}
                  <ArrowUpRight size={12} />
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="correction-editor">
          <label htmlFor="correction">告诉 Agent，接下来怎么做</label>
          <textarea
            id="correction"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={2000}
            autoFocus
            placeholder="例如：只使用页面内存，刷新后清空报名信息。"
          />
          <label className="replace-label">
            这句话如何更新要求？
            <select value={replace} onChange={(e) => setReplace(e.target.value)}>
              <option value="">补充一条新要求</option>
              {run.constraints
                .filter((c) => c.active)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    替换：{c.text}
                  </option>
                ))}
            </select>
          </label>
          <div className="correction-note">保留历史；已完成部分如受影响，将追加修补。</div>
          <div className="inline-buttons">
            <button className="button" disabled={busy} onClick={() => setEditing(false)}>
              取消
            </button>
            <button
              className="button primary"
              disabled={disabled || !text.trim()}
              onClick={() => submit('correct')}
            >
              {busy ? <Loader2 size={14} className="spin" /> : <ArrowRight size={14} />} 提交纠正
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

function Preview({ run }: { run: RunState }) {
  const [refresh, setRefresh] = useState(0),
    file = run.files.find((f) => f.path === 'index.html')
  const panel = useRef<HTMLElement>(null)
  const [fullscreen, setFullscreen] = useState(false),
    [previewError, setPreviewError] = useState('')
  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === panel.current)
    document.addEventListener('fullscreenchange', changed)
    return () => document.removeEventListener('fullscreenchange', changed)
  }, [])
  const source = file ? `/artifacts/${run.id}/index.html?v=${file.hash}` : ''
  return (
    <section className="panel preview-panel large-preview" ref={panel}>
      <div className="panel-title">
        <h3>
          <Eye size={18} /> 成果展示
        </h3>
        <div className="preview-controls">
          {file && (
            <a className="button" href={source} target="_blank" rel="noopener noreferrer">
              <ArrowUpRight size={15} />
              独立页面
            </a>
          )}
          <button
            className="button"
            disabled={!file}
            onClick={async () => {
              try {
                setPreviewError('')
                if (document.fullscreenElement) await document.exitFullscreen()
                else await panel.current?.requestFullscreen()
              } catch {
                setPreviewError('当前浏览器未开启全屏支持，可以使用“独立页面”查看。')
              }
            }}
          >
            {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}{' '}
            {fullscreen ? '退出全屏' : '全屏查看'}
          </button>
          <button
            className="icon-button"
            aria-label="刷新成果预览"
            disabled={!file}
            onClick={() => setRefresh((n) => n + 1)}
          >
            <RotateCcw size={17} />
          </button>
        </div>
      </div>
      {previewError && (
        <p className="addition-error" role="status">
          {previewError}
        </p>
      )}
      {file ? (
        <>
          <div className="preview-browser">
            <span />
            <span />
            <span />
            <small>index.html</small>
            <span className="preview-live">已保存</span>
          </div>
          <iframe
            key={`${file.hash}-${refresh}`}
            title="活动页面预览"
            src={source}
            sandbox="allow-scripts allow-forms"
          />
          <div className="preview-caption">
            <FileText size={12} /> 实际生成文件 · 隔离预览
          </div>
        </>
      ) : (
        <div className="preview-empty">
          <FileText size={27} />
          <p>
            第一个页面生成后，
            <br />
            会在这里与你见面。
          </p>
        </div>
      )}
    </section>
  )
}
function VerificationPanel({ run }: { run: RunState }) {
  const latest = useMemo(() => {
    const map = new Map<string, RunState['verifications'][number]>()
    for (const v of run.verifications) map.set(`${v.path}:${v.name}`, v)
    return [...map.values()]
  }, [run.verifications])
  return (
    <section className="panel verification-panel">
      <div className="panel-title">
        <h3>
          <ShieldCheck size={15} /> 检查有依据
        </h3>
        <span>{latest.length}</span>
      </div>
      {!latest.length ? (
        <p className="muted small-text">还没有检查结果。文件写完不等于验证通过。</p>
      ) : (
        <div className="checks">
          {latest.map((v) => (
            <details key={v.id}>
              <summary>
                <span
                  className={`check-icon ${v.stale ? 'stale' : v.passed ? 'passed' : 'failed'}`}
                >
                  {v.stale ? (
                    <Clock3 size={12} />
                  ) : v.passed ? (
                    <Check size={12} />
                  ) : (
                    <X size={12} />
                  )}
                </span>
                <span>
                  {v.name}
                  <small>
                    {v.stale ? '内容已变化，需重验' : v.passed ? '此项通过' : '此项未通过'}
                  </small>
                </span>
                <ChevronDown size={12} />
              </summary>
              <p>
                {v.detail}
                <br />
                <code>
                  {v.path} · {v.artifactHash.slice(0, 10)}
                </code>
              </p>
            </details>
          ))}
        </div>
      )}
      <div className="verification-footnote">绿色仅代表列出的检查通过。</div>
    </section>
  )
}

function Summary({
  run,
  update,
  reportError,
  onViewStep,
}: {
  run: RunState
  update: (r: RunState) => void
  reportError: (s: string) => void
  onViewStep: (id: string) => void
}) {
  const [reflection, setReflection] = useState(run.reflection),
    [saving, setSaving] = useState(false),
    [saved, setSaved] = useState(false)
  useEffect(() => {
    setReflection(run.reflection)
    setSaved(false)
  }, [run.id])
  const corrections = run.interventions.filter((i) => ['correct', 'enforce'].includes(i.action))
  return (
    <div className="summary-grid">
      <section className="panel summary-main">
        <div className="summary-header">
          <span className="section-symbol">
            <Fingerprint size={24} />
          </span>
          <div>
            <div className="eyebrow">属于你的判断记录</div>
            <h2>你在这些时刻，把握了方向。</h2>
          </div>
          <a className="button" href={`/api/runs/${run.id}/export`}>
            <ArrowDownToLine size={14} /> 导出记录
          </a>
        </div>
        <div className="summary-sentence">
          这次协作中，你作出了 <strong>{corrections.length}</strong> 次纠正，
          <strong>{corrections.filter((i) => i.subsequentStepIds.length).length}</strong>{' '}
          次已有后续改动记录。
        </div>
        {run.interventions.length ? (
          <div className="intervention-list">
            {run.interventions.map((i, index) => (
              <article key={i.id}>
                <span className="intervention-index">{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <div className="intervention-top">
                    <strong>
                      {i.additionKind === 'idea' ? '补充想法' : actionLabel[i.action]}
                    </strong>
                    <time>{time(i.createdAt)}</time>
                  </div>
                  <p>{i.text}</p>
                  <div className="intervention-meta">
                    <span className={i.progress === 'verified' ? 'verified' : ''}>
                      {i.progress === 'verified' && <Check size={12} />} {progressLabel[i.progress]}
                    </span>
                    <span>
                      约束 v{i.fromRevision}
                      {i.toRevision !== i.fromRevision ? ` → v${i.toRevision}` : ''}
                    </span>
                  </div>
                  {i.subsequentStepIds.length > 0 && (
                    <button
                      className="text-button"
                      onClick={() => onViewStep(i.subsequentStepIds[0])}
                    >
                      查看后续动作与证据 <ArrowUpRight size={12} />
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="summary-empty">
            <Fingerprint size={30} />
            <p>还没有显式的干预记录。</p>
            <span>提出需求也是参与。系统不会把没有点击，当作没有贡献。</span>
          </div>
        )}
        <div className="summary-caveat">
          <CircleHelp size={15} />
          <p>
            另有 {run.decisions.filter((d) => d.humanStatus === 'unreviewed').length}{' '}
            项决定尚未审阅。未处理不等于批准；这份记录说明你的参与过程，不给能力打分。
          </p>
        </div>
      </section>
      <aside>
        <section className="panel reflection-panel">
          <BookOpen size={22} />
          <h3>给下次的自己，留一句话。</h3>
          <p>经过这次协作，下次你会提前说清什么？</p>
          <textarea
            aria-label="复盘记录"
            value={reflection}
            onChange={(e) => {
              setReflection(e.target.value)
              setSaved(false)
            }}
            placeholder="比如：涉及用户信息时，先明确数据保留多久…"
            maxLength={3000}
          />
          <button
            className="button primary full"
            disabled={saving}
            onClick={async () => {
              setSaving(true)
              try {
                update(await api<RunState>(`/api/runs/${run.id}/reflection`, { reflection }))
                setSaved(true)
              } catch (e) {
                reportError((e as Error).message)
              } finally {
                setSaving(false)
              }
            }}
          >
            {saving ? (
              <Loader2 size={14} className="spin" />
            ) : saved ? (
              <Check size={14} />
            ) : (
              <Plus size={14} />
            )}{' '}
            {saved ? '已保存' : '保存这句话'}
          </button>
          <small>可选，不影响任务执行。</small>
        </section>
        <VerificationPanel run={run} />
      </aside>
    </div>
  )
}

function SettingsDialog({
  settings,
  onClose,
  onSave,
}: {
  settings: PublicSettings
  onClose: () => void
  onSave: (s: PublicSettings) => void
}) {
  const [worker, setWorker] = useState<ModelConfig>({ ...settings.worker, apiKey: '' }),
    [reviewer, setReviewer] = useState<ModelConfig>({ ...settings.reviewer, apiKey: '' })
  const [timeout, setTimeoutValue] = useState(settings.reviewTimeoutMs),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [success, setSuccess] = useState(false)
  const save = async () => {
    const result = await api<PublicSettings>('/api/settings', {
      worker,
      reviewer,
      reviewTimeoutMs: timeout,
    })
    onSave(result)
    return result
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  const section = (
    role: 'worker' | 'reviewer',
    value: ModelConfig,
    set: (m: ModelConfig) => void,
  ) => (
    <section className="model-section">
      <h3>
        {role === 'worker' ? <Terminal size={17} /> : <ShieldCheck size={17} />}{' '}
        {role === 'worker' ? '执行模型' : '独立审查模型'}
        <small>{role === 'worker' ? '负责把事情做出来' : '负责对照你的要求'}</small>
      </h3>
      <label>
        接口地址
        <input
          value={value.baseUrl}
          onChange={(e) => set({ ...value, baseUrl: e.target.value })}
          placeholder="https://your-provider.example/v1"
        />
      </label>
      <div className="model-fields">
        <label>
          模型名称
          <input
            value={value.model}
            onChange={(e) => set({ ...value, model: e.target.value })}
            placeholder="服务提供的准确模型 ID"
          />
        </label>
        <label>
          模型来源
          <input
            value={value.family}
            onChange={(e) => set({ ...value, family: e.target.value })}
            placeholder="例如 deepseek / qwen"
            list="model-families"
          />
        </label>
      </div>
      <label>
        API 密钥
        <input
          type="password"
          value={value.apiKey}
          autoComplete="new-password"
          onChange={(e) => set({ ...value, apiKey: e.target.value })}
          placeholder={
            settings[role].hasKey ? '已设置；地址不变时留空保留' : '仅保存在当前服务内存中'
          }
        />
      </label>
      <button
        className="text-button"
        disabled={busy || !worker.baseUrl || !reviewer.baseUrl || !worker.model || !reviewer.model}
        onClick={async () => {
          setBusy(true)
          setMessage('')
          try {
            await save()
            const r = await api<{ message: string }>('/api/settings/test', { role })
            setSuccess(true)
            setMessage(r.message)
          } catch (e) {
            setSuccess(false)
            setMessage((e as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Radio size={12} /> 保存并测试连接
      </button>
    </section>
  )
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <section
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div className="modal-header">
          <div>
            <div className="eyebrow">各司其职，独立判断</div>
            <h2 id="settings-title">连接你的两个模型</h2>
          </div>
          <button className="icon-button" aria-label="关闭模型设置" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <p className="settings-description">
          支持 Chat Completions
          兼容接口。审查模型应来自不同的模型系列；网关域名不同不代表模型来源不同。
        </p>
        <datalist id="model-families">
          <option value="deepseek" />
          <option value="qwen" />
          <option value="openai" />
          <option value="anthropic" />
          <option value="google" />
          <option value="moonshot" />
        </datalist>
        <div className="model-grid">
          {section('worker', worker, setWorker)}
          {section('reviewer', reviewer, setReviewer)}
        </div>
        <div className="settings-options">
          <label>
            审查等待上限
            <select value={timeout} onChange={(e) => setTimeoutValue(Number(e.target.value))}>
              <option value={8000}>8 秒</option>
              <option value={15000}>15 秒</option>
              <option value={30000}>30 秒</option>
              <option value={60000}>60 秒</option>
            </select>
          </label>
          <span>超时会暂停该动作，交给你核对。</span>
        </div>
        {message && (
          <div className={`settings-message ${success ? 'success' : 'error'}`} role="status">
            {success ? <Check size={15} /> : <AlertTriangle size={15} />} {message}
          </div>
        )}
        <div className="modal-footer">
          <p>
            <ShieldCheck size={15} /> 密钥不会写入协作日志或浏览器存储。
            <br />
            重启服务后需重新填写，也可使用本地环境配置。
          </p>
          <button
            className="button primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setMessage('')
              try {
                await save()
                setSuccess(true)
                setMessage('设置已保存，仅对下一次真实运行生效。')
              } catch (e) {
                setSuccess(false)
                setMessage((e as Error).message)
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />} 保存设置
          </button>
        </div>
      </section>
    </div>
  )
}
