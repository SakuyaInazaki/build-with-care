import { useEffect, useState } from 'react'
import type { RunState } from '../../../decision-desk/shared/types.js'
import { Spinner } from './ui.js'

const labels = {
  connecting: '正在连接模型',
  thinking: '正在思考',
  writing: '正在生成',
  reviewing: '正在审查本次动作',
  'review-slow': '审查仍在进行',
}

export function RunProgress({ run }: { run: RunState }) {
  const [now, setNow] = useState(Date.now())
  const progress = run.modelProgress
  useEffect(() => {
    if (!progress) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [progress?.startedAt])
  if (!progress || run.status !== 'running' || run.reviewFailure) return null
  const seconds = Math.max(0, Math.floor((now - Date.parse(progress.startedAt)) / 1000))
  return (
    <div className="run-progress" role="status" aria-label={labels[progress.phase]}>
      <Spinner />
      <strong>{labels[progress.phase]}</strong>
      <span>
        {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
      </span>
      {progress.characters > 0 && (
        <span>已接收 {progress.characters.toLocaleString('zh-CN')} 字符</span>
      )}
    </div>
  )
}
