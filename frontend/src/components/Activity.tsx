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
import { timelineEntries, timelineGroups, type EventTone } from '../lib/timeline.js'
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
  const [retry, setRetry] = useState(0)
  const [groupId, setGroupId] = useState<string | null>(null)
  const [currentTime, setCurrentTime] = useState(Date.now)
  const active = run.workUnits?.some(unit => ['declared', 'active'].includes(unit.status))
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setCurrentTime(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  useEffect(() => {
    const controller = new AbortController()
    void fetch(`/api/runs/${run.id}/events`, { signal: controller.signal })
      .then(async response => {
        const result = await response.json()
        if (!response.ok) throw new Error(result.error ?? '记录读取失败。')
        setEvents(result)
        setError('')
      }).catch(cause => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '记录读取失败。')
      })
    return () => controller.abort()
  }, [run.id, run.lastEventSeq, retry])
  const groups = useMemo(() => timelineGroups(events, run, currentTime), [events, run, currentTime])
  const taskRecords = groups.find(group => group.id === 'task-records')
  const unitGroups = groups.filter(group => group.id !== 'task-records')
  const selected = groups.find(group => group.id === groupId)
  const selectedIsTaskRecords = selected?.id === 'task-records'
  return (
    <section className="unit-timeline" aria-label="工作单元时间线">
      {error && <div className="error-banner" role="alert">{error}<button className="button secondary" onClick={() => setRetry(retry + 1)}>重新加载</button></div>}
      {taskRecords && <ul className="unit-rail" aria-label="任务记录">
        <li>
          <button className="unit-summary" aria-expanded={selectedIsTaskRecords}
            aria-controls="unit-events" onClick={() => setGroupId(selectedIsTaskRecords ? null : taskRecords.id)}>
            <span className="unit-summary-meta"><span>任务记录</span><span>{taskRecords.status}</span></span>
            <strong>{taskRecords.title}</strong>
            <span className="unit-summary-meta"><time dateTime={taskRecords.at}>{timeLabel(taskRecords.at)}</time></span>
            <span className="unit-open-label">{selectedIsTaskRecords ? '收起记录' : '查看记录'}<ChevronsRight size={15} /></span>
          </button>
        </li>
      </ul>}
      <ol className="unit-rail" aria-label="工作单元">
        {unitGroups.map((group, index) => (
          <li key={group.id}>
            <button className="unit-summary" aria-expanded={selected?.id === group.id}
              aria-controls="unit-events" onClick={() => setGroupId(selected?.id === group.id ? null : group.id)}>
              <span className="unit-summary-meta"><span>{`单元 ${index + 1}`}</span><span>{group.status}</span></span>
              <strong>{group.title}</strong>
              <span className="unit-summary-meta"><time dateTime={group.at}>{timeLabel(group.at)}</time><span>{`${group.stepCount} 步 · ${group.elapsed}`}</span></span>
              <span className="unit-open-label">{selected?.id === group.id ? '收起步骤' : '查看步骤'}<ChevronsRight size={15} /></span>
            </button>
          </li>
        ))}
      </ol>
      {selected && <section id="unit-events" className="unit-events" aria-label={`${selected.title}的${selectedIsTaskRecords ? '记录' : '步骤'}`}>
        <header className="unit-events-heading"><h2>{selected.title}</h2><button className="button secondary" onClick={() => setGroupId(null)}>{selectedIsTaskRecords ? '收起记录' : '收起步骤'}</button></header>
        <EventTimeline key={selected.id} run={run} events={[...selected.events, ...events.filter(event => event.type === 'run.control-reclassified')]} />
      </section>}
      {!groups.length && !error && <Empty icon={<History size={25} />} title="暂无过程记录" />}
    </section>
  )
}

function EventTimeline({ run, events }: { run: RunState; events: AppEvent[] }) {
  const [filter, setFilter] = useState('all')
  const [retry, setRetry] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [raw, setRaw] = useState(false)
  const [rawDetail, setRawDetail] = useState<unknown>(null)
  const [rawError, setRawError] = useState('')
  const rail = useRef<HTMLOListElement>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
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
  useEffect(() => {
    if (!raw || !selected) return
    const controller = new AbortController()
    setRawDetail(null)
    setRawError('')
    void fetch(`/api/runs/${run.id}/events/${selected.event.seq}/details`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = await response.json()
        if (!response.ok) throw new Error(result.error ?? '记录读取失败。')
        setRawDetail(result)
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setRawError(cause instanceof Error ? cause.message : '记录读取失败。')
      })
    return () => controller.abort()
  }, [raw, selected?.event.id, run.id, run.lastEventSeq, retry])
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
              rawError ? (
                <div className="error-banner">
                  {rawError}
                  <button className="button secondary" onClick={() => setRetry(retry + 1)}>
                    重新加载
                  </button>
                </div>
              ) : (
                <pre className="timeline-source">
                  {rawDetail ? JSON.stringify(rawDetail, null, 2) : '正在读取完整记录…'}
                </pre>
              )
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
