import type { CorrectionMode } from './types.js'

export type DemoStage = 'blue' | 'red' | 'correction' | 'tool' | 'evidence' | 'complete'

export function demoPlan(mode: CorrectionMode): Array<{ stage: DemoStage; action: string }> {
  return [
    { stage: 'blue', action: '记录一个 agent 自主选择的缓存方案' },
    { stage: 'red', action: '拦截与 spec 冲突的 SQLite 方案' },
    { stage: 'correction', action: mode === 'forward-only' ? '向后注入 Postgres 约束' : '从边界 fork 新分支并重做' },
    { stage: 'tool', action: '执行修正后的 Postgres 写入' },
    { stage: 'evidence', action: '运行真实本地检查并绑定 evidence' },
    { stage: 'complete', action: '打开回放与报告' },
  ]
}

export function groupTimelineByStep(events: ReadonlyArray<{ turn?: number; step?: number }>): string[] {
  return [...new Set(events.filter((event) => event.turn !== undefined).map((event) => `${event.turn}:${event.step ?? 0}`))]
}
