import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronsRight,
  CircleDot,
  Code2,
  History,
  MessageSquare,
  ShieldCheck,
  X,
} from 'lucide-react'
import type { AppEvent, RunState } from '../../../decision-desk/shared/types.js'
import { timeLabel } from '../lib/api.js'
import { timelineEntries, type EventTone } from '../lib/timeline.js'
import { Empty } from './ui.js'

function EventIcon({ tone }: { tone: EventTone }) {
  return tone === 'human' ? (
    <MessageSquare size={17} />
  ) : tone === 'verified' ? (
    <ShieldCheck size={17} />
  ) : tone === 'error' || tone === 'attention' ? (
    <AlertCircle size={17} />
  ) : (
    <CircleDot size={17} />
  )
}

export function Activity({ run }: { run: RunState }) {
  const [events, setEvents] = useState<AppEvent[]>([])
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('all')
  const [retry, setRetry] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [raw, setRaw] = useState(false)
  const rail = useRef<HTMLOListElement>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  useEffect(() => {
    const controller = new AbortController()
    void fetch(`/api/runs/${run.id}/events`, { signal: controller.signal })
      .then(async (response) => {
        const result = await response.json()
        if (!response.ok) throw new Error(result.error ?? '记录读取失败。')
        setEvents(result)
        setError('')
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : '记录读取失败。')
      })
    return () => controller.abort()
  }, [run.id, run.lastEventSeq, retry])
  const entries = useMemo(
    () =>
      timelineEntries(events, run).filter(
        ({ event, category }) =>
          filter === 'all' ||
          (filter === 'human' ? category === '你的操作' : event.type.startsWith('verification.')),
      ),
    [events, run, filter],
  )
  const selected = entries.find((entry) => entry.event.id === selectedId) ?? entries.at(-1)
  const index = selected ? entries.indexOf(selected) : -1
  const reveal = (id: string) => {
    const viewport = rail.current
    const button = buttons.current.get(id)
    if (!viewport || !button) return
    const left =
      button.getBoundingClientRect().left -
      viewport.getBoundingClientRect().left +
      viewport.scrollLeft
    viewport.scrollTo({
      left: left - (viewport.clientWidth - button.clientWidth) / 2,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    })
  }
  useLayoutEffect(() => {
    if (selected) reveal(selected.event.id)
  }, [selected?.event.id])
  const choose = (next: number, focus = false) => {
    const entry = entries[next]
    if (!entry) return
    setSelectedId(next === entries.length - 1 ? null : entry.event.id)
    setRaw(false)
    reveal(entry.event.id)
    if (focus) buttons.current.get(entry.event.id)?.focus({ preventScroll: true })
  }
  const keepPosition = () => {
    if (!selectedId && selected) setSelectedId(selected.event.id)
  }
  return (
    <section className="timeline" aria-label="事件时间线">
      <div className="timeline-toolbar">
        <div className="filter-segment" role="group" aria-label="记录类型">
          {[
            { id: 'all', label: '全部记录' },
            { id: 'human', label: '人的判断' },
            { id: 'checks', label: '验证证据' },
          ].map((entry) => (
            <button
              key={entry.id}
              aria-pressed={filter === entry.id}
              onClick={() => {
                setFilter(entry.id)
                setSelectedId(null)
                setRaw(false)
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="timeline-navigation">
          <span className="timeline-count">
            {entries.length ? `${index + 1} / ${entries.length}` : '0 条记录'}
          </span>
          <button
            className="icon-button"
            aria-label="上一条记录"
            disabled={index <= 0}
            onClick={() => choose(index - 1)}
          >
            <ArrowLeft size={17} />
          </button>
          <button
            className="icon-button"
            aria-label="下一条记录"
            disabled={index < 0 || index >= entries.length - 1}
            onClick={() => choose(index + 1)}
          >
            <ArrowRight size={17} />
          </button>
          <button
            className="button text-button timeline-latest"
            disabled={!entries.length}
            onClick={() => choose(entries.length - 1)}
          >
            最新
            <ChevronsRight size={16} />
          </button>
        </div>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
          <button className="button secondary" onClick={() => setRetry(retry + 1)}>
            重新加载
          </button>
        </div>
      )}
      {selected ? (
        <>
          <ol
            className="timeline-rail"
            ref={rail}
            aria-label="按时间排列的事件"
            onWheel={keepPosition}
            onPointerDown={keepPosition}
          >
            {entries.map((entry, entryIndex) => (
              <li
                key={entry.event.id}
                className={`timeline-node tone-${entry.tone} ${selected.event.id === entry.event.id ? 'selected' : ''}`}
              >
                <button
                  className="timeline-event"
                  ref={(element) => {
                    if (element) buttons.current.set(entry.event.id, element)
                    else buttons.current.delete(entry.event.id)
                  }}
                  aria-pressed={selected.event.id === entry.event.id}
                  aria-controls="timeline-content"
                  tabIndex={selected.event.id === entry.event.id ? 0 : -1}
                  onClick={() => choose(entryIndex)}
                  onKeyDown={(event) => {
                    const next =
                      event.key === 'ArrowLeft'
                        ? entryIndex - 1
                        : event.key === 'ArrowRight'
                          ? entryIndex + 1
                          : event.key === 'Home'
                            ? 0
                            : event.key === 'End'
                              ? entries.length - 1
                              : null
                    if (next !== null) {
                      event.preventDefault()
                      choose(next, true)
                    }
                  }}
                >
                  <span className="timeline-moment">
                    <time dateTime={entry.event.at}>{timeLabel(entry.event.at)}</time>
                    <span>{String(entry.event.seq).padStart(2, '0')}</span>
                  </span>
                  <span className="timeline-marker">
                    <EventIcon tone={entry.tone} />
                  </span>
                  <span className="timeline-card">
                    <span className="timeline-category">{entry.category}</span>
                    <strong>{entry.title}</strong>
                    <span className="timeline-excerpt">{entry.summary || entry.title}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <section
            id="timeline-content"
            className={`timeline-content tone-${selected.tone}`}
            aria-labelledby="timeline-event-title"
          >
            <header className="timeline-content-heading">
              <div className="timeline-detail-icon">
                <EventIcon tone={selected.tone} />
              </div>
              <div>
                <p className="timeline-category">
                  {selected.category} · {String(selected.event.seq).padStart(2, '0')}
                </p>
                <h2 id="timeline-event-title">{selected.title}</h2>
                <time dateTime={selected.event.at}>
                  {new Date(selected.event.at).toLocaleDateString('zh-CN', {
                    month: 'long',
                    day: 'numeric',
                  })}{' '}
                  · {timeLabel(selected.event.at)}
                </time>
              </div>
              <button
                className="button text-button timeline-raw"
                aria-pressed={raw}
                onClick={() => setRaw(!raw)}
              >
                <Code2 size={16} />
                {raw ? '事件内容' : '原始记录'}
              </button>
            </header>
            {raw ? (
              <pre className="timeline-source">{JSON.stringify(selected.event.data, null, 2)}</pre>
            ) : (
              <div className="timeline-content-body">
                {selected.summary && <p className="timeline-summary">{selected.summary}</p>}
                {!!selected.fields.length && (
                  <dl className="timeline-fields">
                    {selected.fields.map((field) => (
                      <div key={field.label}>
                        <dt>{field.label}</dt>
                        <dd>{field.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {!!selected.requirements.length && (
                  <ol className="timeline-requirements">
                    {selected.requirements.map((text, i) => (
                      <li key={i}>{text}</li>
                    ))}
                  </ol>
                )}
                {!!selected.checks.length && (
                  <ul className="timeline-checks">
                    {selected.checks.map((check, i) => (
                      <li key={i} className={check.passed ? 'passed' : 'failed'}>
                        {check.passed ? <Check size={17} /> : <X size={17} />}
                        <div>
                          <strong>{check.name}</strong>
                          {check.detail && <p>{check.detail}</p>}
                        </div>
                        <span>{check.passed ? '通过' : '未通过'}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        </>
      ) : (
        <Empty
          icon={<History size={25} />}
          title={events.length ? '还没有这类记录' : '暂无过程记录'}
        />
      )}
    </section>
  )
}
