import type { CorrectionMode } from './types.js'

export type DemoStage = 'blue' | 'red' | 'correction' | 'tool' | 'evidence' | 'runtime-failure' | 'complete'

export interface DemoPlanItem { stage: DemoStage; label: string; action: string }

/** The `full` demo scenario, in order. The server-side demo runner reports these same stage ids. */
export function demoPlan(mode: CorrectionMode): DemoPlanItem[] {
  return [
    { stage: 'blue', label: '蓝卡：自主选择', action: '记录一个 agent 自主选择的缓存方案' },
    { stage: 'red', label: '红卡：约束冲突', action: '拦截与 spec 冲突的 SQLite 方案，等待人裁决' },
    { stage: 'correction', label: '纠偏', action: mode === 'forward-only' ? '向后注入 Postgres 约束，只影响后续' : '从已完成 turn 边界 fork 新分支并重做' },
    { stage: 'tool', label: '执行', action: '执行修正后的 Postgres schema 写入' },
    { stage: 'evidence', label: '证据', action: '运行真实本地检查并绑定 executor evidence（green）' },
    { stage: 'runtime-failure', label: '运行失败', action: '在空工作区运行 npm test，三次失败后升级为阻塞求助' },
    { stage: 'complete', label: '完成', action: '打开回放与一页报告' },
  ]
}

export function groupTimelineByStep(events: ReadonlyArray<{ turn?: number; step?: number }>): string[] {
  return [...new Set(events.filter((event) => event.turn !== undefined).map((event) => `${event.turn}:${event.step ?? 0}`))]
}
