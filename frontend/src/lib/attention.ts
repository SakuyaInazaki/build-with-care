import type { RunState } from '../../../decision-desk/shared/types.js'

export interface AttentionItem {
  key: string
  runId: string
  task: string
  message: string
}

export function attentionItems(runs: RunState[]): AttentionItem[] {
  return runs.flatMap(run => {
    const item = (key: string, message: string): AttentionItem => ({ key: `${run.id}:${key}`, runId: run.id, task: run.title, message })
    const pending = run.gates.filter(gate => gate.status === 'pending')
    if (pending.length) return pending.map(gate => item(`gate:${gate.id}`, '有一项决定需要你判断。'))
    if (run.reviewFailure) return [item(`review:${run.reviewFailure.stepId}`, '审查未完成，需要重试。')]
    if (['error', 'interrupted'].includes(run.status))
      return [item(`${run.status}:${run.revision}:${run.steps.at(-1)?.id ?? 'initial'}`, '任务已中断，需要你处理后继续。')]
    if (run.status === 'ready' && ['question', 'confirm'].includes(run.grill?.status ?? ''))
      return [item(`grill:${run.grill!.status}:${run.grill!.round}`, run.grill!.status === 'confirm' ? '要求已整理好，等待你确认。' : '有一个问题等待你回答。')]
    return []
  })
}
