import { useEffect, useRef, useState } from 'react'
import {
  ArrowDownToLine,
  Check,
  ChevronRight,
  Clock3,
  Code2,
  FileText,
  FolderOpen,
  Maximize2,
  Minimize2,
  RotateCw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import type { RunState } from '../../../decision-desk/shared/types.js'
import { api, timeLabel } from '../lib/api.js'
import { actionLabels, currentChecks, isActive, progressLabels } from '../lib/board.js'
import { Dialog, Empty, ExternalLink, Spinner } from './ui.js'

function Checks({ run }: { run: RunState }) {
  const checks = currentChecks(run)
  return (
    <aside className="checks-panel" aria-label="产物验证证据">
      <h2>
        <ShieldCheck size={17} /> 验证证据
      </h2>
      <div className="checks-list">
        {checks.map((check) => (
          <details
            key={check.id}
            className={`check-entry ${check.stale ? 'stale' : check.passed ? 'passed' : 'failed'}`}
          >
            <summary>
              {check.stale ? (
                <Clock3 size={16} />
              ) : check.passed ? (
                <Check size={16} />
              ) : (
                <X size={16} />
              )}
              <span>
                {check.name}
                <small>
                  {check.stale ? '需重新验证' : check.passed ? '此项通过' : '此项未通过'}
                </small>
              </span>
              <ChevronRight size={13} />
            </summary>
            <p>
              {check.detail}
              <br />
              <code>{check.path}</code>
              <br />
              <code>{check.artifactHash}</code>
            </p>
          </details>
        ))}
      </div>
      {!checks.length && <p>暂无检查结果</p>}
    </aside>
  )
}

export function Artifacts({ run }: { run: RunState }) {
  const [path, setPath] = useState(
    run.files.find((file) => file.path === 'index.html')?.path ?? run.files[0]?.path ?? '',
  )
  const [source, setSource] = useState(false)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  const panel = useRef<HTMLElement>(null)
  const file = run.files.find((entry) => entry.path === path) ?? run.files[0]
  const html = !!file?.path.match(/\.html?$/i)
  const url = file
    ? `/artifacts/${run.id}/${file.path.split('/').map(encodeURIComponent).join('/')}?v=${file.hash}`
    : ''
  useEffect(() => {
    const listener = () => setFullscreen(document.fullscreenElement === panel.current)
    document.addEventListener('fullscreenchange', listener)
    return () => document.removeEventListener('fullscreenchange', listener)
  }, [])
  useEffect(() => {
    if (!url || (html && !source)) return
    const abort = new AbortController()
    setError('')
    setText('正在读取文件…')
    void fetch(url, { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('文件暂时不可用。')
        return response.text()
      })
      .then(setText)
      .catch((cause) => {
        if (!abort.signal.aborted)
          setError(cause instanceof Error ? cause.message : '文件读取失败。')
      })
    return () => abort.abort()
  }, [url, html, source, refresh])
  return (
    <div className="artifacts-layout">
      <section className="artifact-view" ref={panel}>
        {file ? (
          <>
            <div className="artifact-toolbar">
              <select
                aria-label="选择成果文件"
                value={file.path}
                onChange={(event) => setPath(event.target.value)}
              >
                {run.files.map((entry) => (
                  <option key={entry.path}>{entry.path}</option>
                ))}
              </select>
              {html && (
                <button
                  className="icon-button"
                  aria-label={source ? '查看页面预览' : '查看文件内容'}
                  aria-pressed={source}
                  onClick={() => setSource(!source)}
                >
                  <Code2 size={17} />
                </button>
              )}
              <button
                className="icon-button"
                aria-label="刷新成果预览"
                onClick={() => setRefresh(refresh + 1)}
              >
                <RotateCw size={17} />
              </button>
              <button
                className="icon-button"
                aria-label={fullscreen ? '退出全屏' : '全屏查看成果'}
                onClick={async () => {
                  try {
                    if (document.fullscreenElement) await document.exitFullscreen()
                    else await panel.current?.requestFullscreen()
                  } catch {
                    setError('当前浏览器不支持全屏，可在独立页面查看。')
                  }
                }}
              >
                {fullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
              </button>
              <ExternalLink href={url}>独立打开</ExternalLink>
            </div>
            {error && (
              <div className="error-banner" role="alert">
                {error}
              </div>
            )}
            {html && !source ? (
              <iframe
                key={`${url}-${refresh}`}
                title="成果页面预览"
                src={url}
                sandbox="allow-scripts allow-forms"
              />
            ) : (
              <pre className="artifact-source">{text}</pre>
            )}
            <div className="artifact-caption">
              <span>
                <FileText size={13} /> {Math.ceil(file.bytes / 1024)} KB · 已保存
              </span>
              <span>
                内容指纹 <code>{file.hash.slice(0, 12)}</code>
              </span>
            </div>
          </>
        ) : (
          <Empty icon={<FolderOpen size={26} />} title="成果还在路上">
            暂无可预览文件
          </Empty>
        )}
      </section>
      <Checks run={run} />
    </div>
  )
}

export function RecordView({
  run,
  update,
  onDeleted,
}: {
  run: RunState
  update: (run: RunState) => void
  onDeleted: () => void
}) {
  const [reflection, setReflection] = useState(run.reflection)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const corrections = run.interventions.filter((entry) =>
    ['correct', 'enforce'].includes(entry.action),
  )
  const unreviewed = run.decisions.filter(
    (decision) => decision.humanStatus === 'unreviewed',
  ).length
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      update(await api<RunState>(`/api/runs/${run.id}/reflection`, { reflection }))
      setMessage('复盘已保存。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败。')
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    setBusy(true)
    setError('')
    try {
      await api(`/api/runs/${run.id}`, {}, 'DELETE')
      onDeleted()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除失败。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="record-layout">
        <section className="record-main">
          <p className="record-lead">
            这次任务，
            <br />
            你留下了 <span>{run.interventions.length}</span> 次判断，
            <br />
            其中 <span>{corrections.length}</span> 次纠正了做法。
          </p>
          {run.interventions.map((entry) => {
            const paths = new Set(
              run.steps
                .filter((step) => entry.subsequentStepIds.includes(step.id))
                .map((step) => step.args.path),
            )
            const checks = currentChecks(run).filter(
              (check) => paths.has(check.path) && check.createdAt >= entry.createdAt,
            )
            const verified =
              entry.progress === 'verified' &&
              checks.length > 0 &&
              checks.every((check) => check.passed && !check.stale)
            const label =
              entry.progress === 'verified' && !verified
                ? '证据已失效，等待重新验证'
                : progressLabels[entry.progress]
            return (
              <article key={entry.id} className="record-entry">
                <header>
                  <h3>{actionLabels[entry.action]}</h3>
                  <time>{timeLabel(entry.createdAt)}</time>
                </header>
                <p>{entry.text}</p>
                <div className={`evidence-stage ${verified ? 'verified' : ''}`}>
                  {verified ? <ShieldCheck size={14} /> : <Clock3 size={14} />}
                  {label}
                  <span>· 要求 v{entry.toRevision}</span>
                </div>
              </article>
            )
          })}
          {!run.interventions.length && <p className="muted">暂无判断记录</p>}
          <p className="muted" style={{ marginTop: 24 }}>
            未审阅 · {unreviewed}
          </p>
        </section>
        <aside>
          {run.archivedAt ? (
            <section className="reflection-panel" aria-label="已保存的复盘">
              <h2>留给下次的自己</h2>
              <p>{run.reflection || '尚未保存复盘'}</p>
            </section>
          ) : (
            <form
              className="reflection-panel"
              onSubmit={(event) => {
                event.preventDefault()
                void save()
              }}
            >
              <h2>留给下次的自己</h2>
              <p>回看这些决定，下次你会提前说清什么？</p>
              <label htmlFor="reflection">我的复盘</label>
              <textarea
                id="reflection"
                value={reflection}
                maxLength={3000}
                onChange={(event) => setReflection(event.target.value)}
                placeholder="写下这次的发现…"
              />
              <button className="button secondary" disabled={busy}>
                {busy ? <Spinner /> : <Check size={15} />}保存复盘
              </button>
              {message && (
                <p className="saved-note" role="status">
                  {message}
                </p>
              )}
            </form>
          )}
        </aside>
      </div>
      {error && !deleting && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <div className="record-actions">
        <a className="button secondary" href={`/api/runs/${run.id}/export`} download>
          <ArrowDownToLine size={16} />
          导出完整记录
        </a>
        <button
          className="button text-button delete-task"
          disabled={isActive(run)}
          onClick={() => {
            setDeleting(true)
            setConfirmText('')
            setError('')
          }}
        >
          <Trash2 size={15} />
          删除任务数据
        </button>
      </div>
      {deleting && (
        <Dialog
          title="删除这次任务的数据"
          onClose={() => {
            if (!busy) setDeleting(false)
          }}
        >
          <form
            className="delete-confirm"
            onSubmit={(event) => {
              event.preventDefault()
              void remove()
            }}
          >
            <p>将永久删除此任务的要求、过程记录和生成文件，无法恢复。</p>
            <label htmlFor="delete-confirm">输入“删除”以确认</label>
            <input
              id="delete-confirm"
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              autoComplete="off"
            />
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
            <div className="form-actions">
              <button
                className="button secondary"
                type="button"
                disabled={busy}
                onClick={() => setDeleting(false)}
              >
                保留任务
              </button>
              <button className="button danger" disabled={busy || confirmText !== '删除'}>
                {busy ? <Spinner /> : <Trash2 size={15} />}永久删除
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  )
}
