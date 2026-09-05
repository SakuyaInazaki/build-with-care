import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  FileText,
  MessageSquare,
  Plus,
  ShieldCheck,
  Square,
  X,
} from 'lucide-react'
import type { RunState } from '../../../decision-desk/shared/types.js'
import { api, requestId, timeLabel } from '../lib/api.js'
import {
  boardItems,
  humanLabels,
  isReadOnly,
  laneLabels,
  stepLabels,
  type BoardItem,
  type Lane,
} from '../lib/board.js'
import { Spinner } from './ui.js'

const lanes: Lane[] = ['attention', 'active', 'validation', 'verified']
const emptyCopy = {
  attention: '暂无待处理',
  active: '暂无进行中事项',
  validation: '暂无待验证事项',
  verified: '暂无验证结果',
}

export function Board({
  run,
  update,
  stop,
  notify,
}: {
  run: RunState
  update: (run: RunState) => void
  stop: () => Promise<void>
  notify: (text: string) => void
}) {
  const items = useMemo(() => boardItems(run), [run])
  const [selected, setSelected] = useState<string | null>(null)
  const [constraintsOpen, setConstraintsOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const focused = items.find((item) => item.id === selected)
  const constraints = run.constraints.filter((constraint) => constraint.active)
  return (
    <>
      <div className="board-toolbar">
        <button
          className="constraint-toggle"
          aria-expanded={constraintsOpen}
          onClick={() => setConstraintsOpen(!constraintsOpen)}
        >
          <ShieldCheck size={16} />
          已确认要求<span className="version">v{run.revision}</span>
          <span className="muted">{constraints.length} 条</span>
          <ChevronDown className={constraintsOpen ? 'rotated' : ''} size={15} />
        </button>
        <button
          className="button text-button"
          onClick={() => setAdding(!adding)}
          disabled={run.status === 'ready' || run.status === 'stopping'}
        >
          <Plus size={16} />
          补充要求
        </button>
      </div>
      {constraintsOpen && (
        <div className="constraint-sheet">
          {constraints.map((constraint, index) => (
            <div key={constraint.id}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <p>{constraint.text}</p>
            </div>
          ))}
          <details>
            <summary>原始要求</summary>
            <p>{run.prompt}</p>
          </details>
        </div>
      )}
      {adding && (
        <Addition run={run} update={update} close={() => setAdding(false)} notify={notify} />
      )}
      <div className="board" aria-label="按状态分栏的决策看板">
        {lanes.map((lane) => {
          const cards = items.filter((item) => item.lane === lane)
          return (
            <section className={`board-lane lane-${lane}`} key={lane} aria-label={laneLabels[lane]}>
              <header className="lane-heading">
                <span className={`lane-indicator ${lane}`} />
                <h2>{laneLabels[lane]}</h2>
                <span className="lane-count">{cards.length}</span>
              </header>
              <div className="lane-cards">
                {cards.map((item) => (
                  <Card
                    key={item.id}
                    item={item}
                    selected={selected === item.id}
                    select={() => setSelected(selected === item.id ? null : item.id)}
                  />
                ))}
                {!cards.length && (
                  <div className="lane-empty">
                    {lane === 'verified' ? (
                      <ShieldCheck size={23} />
                    ) : lane === 'attention' ? (
                      <Check size={23} />
                    ) : (
                      <Circle size={20} />
                    )}
                    <p>{emptyCopy[lane as keyof typeof emptyCopy]}</p>
                  </div>
                )}
              </div>
            </section>
          )
        })}
      </div>
      {focused && (
        <DecisionDetail
          key={focused.id}
          item={focused}
          run={run}
          update={update}
          stop={stop}
          close={() => setSelected(null)}
          notify={notify}
        />
      )}
      {items.some((item) => item.lane === 'closed') && (
        <details className="closed-items">
          <summary>
            <ChevronRight size={16} />
            已停止与已拦停<span>{items.filter((item) => item.lane === 'closed').length}</span>
          </summary>
          <div className="closed-grid">
            {items
              .filter((item) => item.lane === 'closed')
              .map((item) => (
                <Card
                  key={item.id}
                  item={item}
                  selected={selected === item.id}
                  select={() => setSelected(item.id)}
                />
              ))}
          </div>
        </details>
      )}
    </>
  )
}

function Card({
  item,
  selected,
  select,
}: {
  item: BoardItem
  selected: boolean
  select: () => void
}) {
  const step = item.steps.at(-1)
  return (
    <button
      className={`decision-card tone-${item.tone} ${selected ? 'is-selected' : ''}`}
      onClick={select}
      aria-expanded={selected}
      aria-controls={selected ? 'decision-detail' : undefined}
    >
      <span className="card-eyebrow">
        <span>
          {item.gate
            ? item.decision?.review.classification === 'uncertain'
              ? '审查需要核对'
              : '约束冲突'
            : item.lane === 'verified'
              ? '受控检查通过'
              : item.tone === 'red'
                ? '冲突处理记录'
                : item.decision
                  ? 'Agent 自主决定'
                  : '执行记录'}
        </span>
        {item.gate ? (
          <AlertCircle size={15} />
        ) : item.lane === 'verified' ? (
          <ShieldCheck size={15} />
        ) : (
          <Circle size={13} />
        )}
      </span>
      <h3>{item.title}</h3>
      <p className="card-summary">{item.summary}</p>
      {item.decision && (
        <span className="human-status">{humanLabels[item.decision.humanStatus]}</span>
      )}
      <span className="card-footer">
        <span>
          <FileText size={13} />
          {String(step?.args.path ?? `${item.steps.length} 个动作`)}
        </span>
        <span>
          {item.gate ? '待处理' : step ? stepLabels[step.status] : ''}
          <ChevronRight size={14} />
        </span>
      </span>
    </button>
  )
}

function DecisionDetail({
  item,
  run,
  update,
  stop,
  close,
  notify,
}: {
  item: BoardItem
  run: RunState
  update: (run: RunState) => void
  stop: () => Promise<void>
  close: () => void
  notify: (text: string) => void
}) {
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    panel.current?.scrollIntoView({
      block: 'nearest',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    })
  }, [])
  const [editing, setEditing] = useState<'alternative' | 'allow' | null>(null)
  const [text, setText] = useState('')
  const [replace, setReplace] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!item.gate) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [item.gate?.id])
  const remaining = item.gate
    ? Math.max(0, Math.ceil((Date.parse(item.gate.expiresAt) - now) / 1000))
    : 0
  const stale = !!item.gate && (item.gate.revision !== run.revision || remaining === 0)
  const disabled = busy || isReadOnly(run) || stale
  const review = item.decision?.review ?? item.steps.at(-1)?.review
  const constraints = run.constraints.filter((constraint) =>
    review?.constraintIds.includes(constraint.id),
  )
  const submit = async (action: 'rewrite' | 'alternative' | 'allow' | 'acknowledge' | 'cancel') => {
    setBusy(true)
    setError('')
    try {
      if (action === 'cancel') {
        await stop()
        close()
        return
      }
      if (!item.decision) return
      await api(`/api/runs/${run.id}/verdict`, {
        requestId: requestId(),
        revision: run.revision,
        decisionId: item.decision.id,
        gateId: item.gate?.id,
        action,
        ...(action === 'alternative'
          ? { text, ...(replace ? { replaceConstraintId: replace } : {}) }
          : {}),
      })
      update(await api<RunState>(`/api/runs/${run.id}`))
      setEditing(null)
      notify(
        action === 'acknowledge'
          ? '已记录你的认可。'
          : action === 'allow'
            ? '仅本次调用已获允许，原约束保持有效。'
            : '已提交纠正，等待后续执行与验证。',
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作未完成。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      ref={panel}
      className="decision-detail"
      id="decision-detail"
      aria-label={`${item.title}的详情`}
    >
      <header className="detail-heading">
        <div>
          <span className={`detail-kicker ${item.tone}`}>
            {item.gate ? '执行前，等你决定' : '决定与证据'}
          </span>
          <h2>{item.title}</h2>
        </div>
        <button className="icon-button" onClick={close} aria-label="收起决策详情">
          <X size={20} />
        </button>
      </header>
      <div className="comparison">
        <section>
          <div className="comparison-label">
            <MessageSquare size={16} />
            <h3>你的要求</h3>
            <span className="version">
              v{item.gate?.revision ?? item.decision?.revision ?? run.revision}
            </span>
          </div>
          {constraints.length ? (
            constraints.map((constraint) => (
              <blockquote key={constraint.id}>{constraint.text}</blockquote>
            ))
          ) : (
            <blockquote>
              {item.decision?.review.classification === 'choice'
                ? '你没有限定这里的具体做法。'
                : run.prompt}
            </blockquote>
          )}
          <p className="muted">
            {item.decision?.humanStatus === 'unreviewed'
              ? '未审阅'
              : item.decision
                ? humanLabels[item.decision.humanStatus]
                : '以已确认要求为准。'}
          </p>
        </section>
        <section>
          <div className="comparison-label">
            <Circle size={16} />
            <h3>{item.gate ? 'Agent 准备做' : 'Agent 的行动'}</h3>
          </div>
          <p className="action-summary">{item.summary}</p>
          {review?.impact && (
            <div className="impact-note">
              <span>影响</span>
              <p>{review.impact}</p>
            </div>
          )}
          {review?.evidence && (
            <details className="evidence-disclosure">
              <summary>
                <ChevronRight size={14} />
                审查依据
              </summary>
              <pre>{review.evidence}</pre>
            </details>
          )}
        </section>
      </div>
      <div className="tool-evidence">
        {item.steps.map((step) => (
          <details key={step.id}>
            <summary>
              <ChevronRight size={14} />
              <code>{step.tool}</code>
              <span>{stepLabels[step.status]}</span>
              <time>{timeLabel(step.createdAt)}</time>
            </summary>
            <div className="tool-evidence-body">
              <h4>本次调用内容</h4>
              <pre>{JSON.stringify(step.args, null, 2)}</pre>
              {step.result && (
                <>
                  <h4>实际返回结果</h4>
                  <pre>{step.result}</pre>
                </>
              )}
            </div>
          </details>
        ))}
      </div>
      {item.checks.length > 0 && (
        <div className="detail-checks">
          {item.checks.map((check) => (
            <div key={check.id}>
              <ShieldCheck size={15} />
              <strong>{check.name}</strong>
              <span>{check.stale ? '已失效，需重验' : check.passed ? '通过' : '未通过'}</span>
              <code>{check.artifactHash.slice(0, 12)}</code>
            </div>
          ))}
        </div>
      )}
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {stale && (
        <div className="error-banner">
          {remaining === 0
            ? '等待已到期，此调用不能继续放行。'
            : '要求已更新，此卡须按新版本重新审查。'}
        </div>
      )}
      {item.decision && (
        <div className="decision-controls">
          {item.gate && (
            <div className="gate-note">
              <span>
                <span className="status-dot waiting" />
                此调用尚未执行
              </span>
              <span>
                <Clock3 size={14} />
                {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')} 后到期
              </span>
            </div>
          )}
          {editing === 'alternative' ? (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void submit('alternative')
              }}
              className="correction-form"
            >
              <label htmlFor="correction-text">接下来，改成怎样做？</label>
              <textarea
                id="correction-text"
                value={text}
                onChange={(event) => setText(event.target.value)}
                maxLength={2000}
                required
                placeholder="写下你确认的新要求…"
              />
              <label htmlFor="replace-constraint">如何更新要求</label>
              <select
                id="replace-constraint"
                value={replace}
                onChange={(event) => setReplace(event.target.value)}
              >
                <option value="">补充一条新要求</option>
                {run.constraints
                  .filter((constraint) => constraint.active)
                  .map((constraint) => (
                    <option value={constraint.id} key={constraint.id}>
                      替换：{constraint.text}
                    </option>
                  ))}
              </select>
              <p className="fine-print">
                提交即确认新的约束版本。旧调用被拒绝，Agent 按新要求重提；已完成的动作保留。
              </p>
              <div className="form-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setEditing(null)}
                  disabled={busy}
                >
                  返回
                </button>
                <button className="button primary" disabled={disabled || !text.trim()}>
                  {busy ? <Spinner /> : <Check size={16} />}确认新要求并纠正
                </button>
              </div>
            </form>
          ) : editing === 'allow' ? (
            <div className="allow-review">
              <h3>仅允许这里列出的这一次调用</h3>
              <p>原约束继续有效，之后的调用仍需重新审查。</p>
              <pre>{JSON.stringify(item.steps[0]?.args, null, 2)}</pre>
              <p className="hash-line">
                调用指纹 <code>{item.gate?.argsHash}</code>
              </p>
              <div className="form-actions">
                <button
                  className="button secondary"
                  onClick={() => setEditing(null)}
                  disabled={busy}
                >
                  返回
                </button>
                <button
                  className="button primary"
                  disabled={disabled}
                  onClick={() => void submit('allow')}
                >
                  {busy ? <Spinner /> : <Check size={16} />}确认仅本次允许
                </button>
              </div>
            </div>
          ) : (
            <div className="decision-actions">
              {item.gate ? (
                <>
                  <button
                    className="button primary"
                    disabled={disabled}
                    onClick={() => void submit('rewrite')}
                  >
                    {busy ? <Spinner /> : <ArrowRight size={16} />}按原要求改正
                  </button>
                  <button
                    className="button secondary"
                    disabled={disabled}
                    onClick={() => setEditing('alternative')}
                  >
                    改成另一种做法
                  </button>
                  <button
                    className="button secondary"
                    disabled={disabled}
                    onClick={() => setEditing('allow')}
                  >
                    仅本次允许
                  </button>
                  <button
                    className="button text-button stop-action"
                    disabled={busy || isReadOnly(run)}
                    onClick={() => void submit('cancel')}
                  >
                    <Square size={12} />
                    停止任务
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="button primary"
                    disabled={disabled || item.decision.humanStatus !== 'unreviewed'}
                    onClick={() => void submit('acknowledge')}
                  >
                    <Check size={16} />
                    {item.decision.humanStatus === 'acknowledged' ? '已认可' : '认可'}
                  </button>
                  <button
                    className="button secondary"
                    disabled={disabled}
                    onClick={() => setEditing('alternative')}
                  >
                    纠正
                  </button>
                  <span className="muted">
                    {humanLabels[item.decision.humanStatus]} · 不阻塞执行
                  </span>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function Addition({
  run,
  update,
  close,
  notify,
}: {
  run: RunState
  update: (run: RunState) => void
  close: () => void
  notify: (text: string) => void
}) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async () => {
    setBusy(true)
    setError('')
    try {
      update(
        await api<RunState>(`/api/runs/${run.id}/additions`, {
          requestId: requestId(),
          revision: run.revision,
          kind: 'requirement',
          text,
        }),
      )
      notify('新要求已确认，后续动作将按新版本执行。')
      close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '补充未完成。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="addition-panel"
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
    >
      <div className="section-heading">
        <label htmlFor="addition-text">补充已确认的新要求</label>
        <button type="button" className="icon-button" aria-label="关闭补充要求" onClick={close}>
          <X size={17} />
        </button>
      </div>
      <textarea
        id="addition-text"
        placeholder="说明后续执行需要遵守的新要求…"
        value={text}
        onChange={(event) => setText(event.target.value)}
        required
        maxLength={3000}
      />
      <div className="composer-bottom">
        <button className="button primary" disabled={busy || !text.trim()}>
          {busy ? <Spinner /> : <Plus size={16} />}确认并补充
        </button>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}
