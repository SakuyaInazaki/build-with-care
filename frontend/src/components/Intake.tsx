import { useState } from 'react'
import { ArrowRight, Check, ChevronRight, MessageSquare, Plus, ShieldCheck, X } from 'lucide-react'
import type { RunState } from '../../../decision-desk/shared/types.js'
import { api } from '../lib/api.js'
import { Spinner } from './ui.js'

export function Intake({
  run,
  update,
  notify,
}: {
  run: RunState
  update: (run: RunState) => void
  notify: (text: string) => void
}) {
  const [answer, setAnswer] = useState('')
  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const grill = run.grill
  const next = async () => {
    setBusy(true)
    setError('')
    try {
      update(
        await api<RunState>(`/api/runs/${run.id}/grill`, {
          round: grill?.round ?? 0,
          ...(grill?.status === 'question' ? { answer: answer.trim() || choice } : {}),
        }),
      )
      setAnswer('')
      setChoice('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '需求整理未完成。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="intake">
      <div className="intake-progress">
        <span>
          {grill?.status === 'confirm' || run.mode === 'demo'
            ? '最后一步 · 由你确认'
            : `需求澄清 · ${grill?.round ? `第 ${grill.round} 题` : '尚未开始'} / 最多 5 题`}
        </span>
        <span className="progress-dots">
          {Array.from({ length: 5 }, (_, index) => (
            <i key={index} className={index < (grill?.round ?? 0) ? 'filled' : ''} />
          ))}
        </span>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {grill?.status === 'confirm' || run.mode === 'demo' ? (
        <Confirmation run={run} update={update} notify={notify} />
      ) : (
        <form
          className="question-panel"
          onSubmit={(event) => {
            event.preventDefault()
            void next()
          }}
        >
          <span className="eyebrow">
            <MessageSquare size={15} />{' '}
            {grill?.status === 'question' ? '先确认一件重要的事' : '把需求说清楚'}
          </span>
          <h2>{grill?.question?.title ?? '先对齐要求，再开始执行。'}</h2>
          <p>{grill?.question?.reason ?? ''}</p>
          {grill?.question && (
            <>
              <div className="question-options" role="radiogroup" aria-label="本轮选项">
                {grill.question.options.map((option, index) => (
                  <label className="question-option" key={option}>
                    <input
                      type="radio"
                      name="grill-choice"
                      checked={choice === option && !answer}
                      onChange={() => {
                        setChoice(option)
                        setAnswer('')
                      }}
                    />
                    <span>
                      {option}
                      <small>选项 {index + 1}</small>
                    </span>
                  </label>
                ))}
              </div>
              <label htmlFor="grill-answer">也可以用自己的话回答</label>
              <textarea
                id="grill-answer"
                value={answer}
                onChange={(event) => {
                  setAnswer(event.target.value)
                  if (event.target.value) setChoice('')
                }}
                maxLength={4000}
                placeholder="写下你的具体要求…"
              />
            </>
          )}
          <div className="form-actions">
            <button
              className="button primary"
              disabled={busy || (!!grill?.question && !answer.trim() && !choice)}
            >
              {busy ? <Spinner /> : <ArrowRight size={16} />}
              {busy ? '正在整理…' : grill?.question ? '确认回答，继续' : '开始澄清'}
            </button>
          </div>
        </form>
      )}
      {!!grill?.answers.length && (
        <details className="intake-history">
          <summary>
            <ChevronRight size={15} />
            已确认的回答 · {grill.answers.length}
          </summary>
          {grill.answers.map((entry, index) => (
            <div key={index}>
              <p>{entry.question}</p>
              <small>{entry.answer}</small>
            </div>
          ))}
        </details>
      )}
    </div>
  )
}

function Confirmation({
  run,
  update,
  notify,
}: {
  run: RunState
  update: (run: RunState) => void
  notify: (text: string) => void
}) {
  const [constraints, setConstraints] = useState(
    run.grill?.constraints ?? run.constraints.map((constraint) => constraint.text),
  )
  const [accepted, setAccepted] = useState(false)
  const [resolutions, setResolutions] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const assumptions = run.grill?.assumptions ?? []
  const unresolved = run.grill?.unresolved ?? []
  const valid =
    constraints.length > 0 &&
    constraints.every((constraint) => constraint.trim()) &&
    (!assumptions.length || accepted) &&
    unresolved.every((item) => resolutions[item]?.trim())
  const start = async () => {
    setBusy(true)
    setError('')
    try {
      update(
        await api<RunState>(`/api/runs/${run.id}/start`, {
          constraints,
          confirmation: {
            confirmed: true,
            acceptedAssumptions: accepted || !assumptions.length,
            unresolved: unresolved.map((item) => ({ item, answer: resolutions[item] })),
          },
        }),
      )
      notify('要求已确认，开始执行。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '任务未能开始。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="confirmation-panel"
      onSubmit={(event) => {
        event.preventDefault()
        void start()
      }}
    >
      <span className="eyebrow">
        <ShieldCheck size={16} /> 需求确认
      </span>
      <h2>这些要求，由你最后确认。</h2>
      <section className="confirmation-section">
        <h3>已明确的要求</h3>
        {constraints.map((constraint, index) => (
          <div className="constraint-input" key={index}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            <input
              aria-label={`要求 ${index + 1}`}
              value={constraint}
              maxLength={2000}
              onChange={(event) =>
                setConstraints((previous) =>
                  previous.map((value, i) => (i === index ? event.target.value : value)),
                )
              }
            />
            <button
              type="button"
              className="icon-button"
              aria-label={`移除要求 ${index + 1}`}
              disabled={constraints.length === 1}
              onClick={() => setConstraints((previous) => previous.filter((_, i) => i !== index))}
            >
              <X size={15} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="button text-button"
          disabled={constraints.length >= 24}
          onClick={() => setConstraints([...constraints, ''])}
        >
          <Plus size={15} />
          添加要求
        </button>
      </section>
      {!!assumptions.length && (
        <section className="confirmation-section">
          <h3>模型建议补全</h3>
          <ul className="assumption-list">
            {assumptions.map((assumption) => (
              <li key={assumption}>{assumption}</li>
            ))}
          </ul>
          <label className="check-label">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(event) => setAccepted(event.target.checked)}
            />
            我确认以上补全内容，纳入执行要求
          </label>
        </section>
      )}
      <section className="confirmation-section">
        <h3>仍未决定的事项</h3>
        {unresolved.length ? (
          unresolved.map((item, index) => (
            <div className="unresolved-item" key={item}>
              <label htmlFor={`resolution-${index}`}>{item}</label>
              <input
                id={`resolution-${index}`}
                value={resolutions[item] === '保持未指定' ? '' : (resolutions[item] ?? '')}
                disabled={resolutions[item] === '保持未指定'}
                placeholder="填写你的决定"
                maxLength={2000}
                onChange={(event) => setResolutions({ ...resolutions, [item]: event.target.value })}
              />
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={resolutions[item] === '保持未指定'}
                  onChange={(event) =>
                    setResolutions({
                      ...resolutions,
                      [item]: event.target.checked ? '保持未指定' : '',
                    })
                  }
                />
                我确认此项保持未指定
              </label>
            </div>
          ))
        ) : (
          <p className="muted">没有待你处理的未决事项。</p>
        )}
      </section>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <div className="form-actions">
        <button className="button primary" disabled={busy || !valid}>
          {busy ? <Spinner /> : <Check size={16} />}确认要求，开始执行
        </button>
      </div>
    </form>
  )
}
