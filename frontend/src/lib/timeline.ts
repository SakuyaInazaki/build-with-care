import type { AppEvent, RunState } from '../../../decision-desk/shared/types.js'
import { actionLabels, stepLabels } from './board.js'

export type EventTone = 'neutral' | 'human' | 'attention' | 'error' | 'verified'
export interface TimelineEntry {
  event: AppEvent
  title: string
  summary: string
  category: string
  tone: EventTone
  fields: { label: string; value: string }[]
  requirements: string[]
  checks: { name: string; passed: boolean; detail: string }[]
}
const titles: Record<string, string> = {
  'run.created': '创建任务',
  'constraints.confirmed': '确认执行要求',
  'grill.updated': '需求澄清',
  'run.started': '开始执行',
  'model.request': '请求执行模型',
  'tool.proposed': '提出执行动作',
  'tool.allowed': '审查通过',
  'tool.finished': '动作执行完成',
  'tool.cancelled': '动作已取消',
  'gate.pending': '等待你的判断',
  'gate.resolved': '已处理待定动作',
  'gate.cancelled': '待定动作已取消',
  'gate.expired': '等待已到期',
  'gate.invalidated': '待定动作已失效',
  'human.intervention': '你作出了判断',
  'human.reflection': '保存复盘',
  'artifact.written': '更新成果文件',
  'verification.completed': '完成检查',
  'review.invalidated': '原审查已失效',
  'review.failed': '审查服务未完成',
  'run.stopped': '任务已停止',
  'run.stop-requested': '请求停止',
  'run.completed': '本轮执行结束',
  'run.settled': '本轮执行结束',
  'run.interrupted': '运行中断',
  'run.error': '执行遇到问题',
  'run.failed': '执行遇到问题',
  'run.input-added': '加入新要求',
  'run.continuing': '继续执行',
  'run.explicit-continuation': '继续执行',
  'run.resume-requested': '继续任务',
  'intervention.delivered': '已传达你的决定',
  message: '执行消息',
}
const tools: Record<string, string> = {
  list_files: '查看项目文件',
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '修改文件',
  verify_app: '检查页面',
}
export function isHumanEvent(event: AppEvent) {
  return event.type.startsWith('human.') || event.type === 'constraints.confirmed'
}
const readable = (value: unknown) => (typeof value === 'string' ? value : '')

export function timelineEntries(events: AppEvent[], run: RunState): TimelineEntry[] {
  const steps = new Map(run.steps.map((step) => [step.id, step]))
  const correctedControls = new Set(
    events
      .filter((event) => event.type === 'run.control-reclassified')
      .map(
        (event) =>
          (event.data as { previousIntervention?: { id?: string } })?.previousIntervention?.id,
      )
      .filter(Boolean),
  )
  return events
    .filter((event) => event.type !== 'run.control-reclassified')
    .sort((a, b) => a.seq - b.seq)
    .map((event) => {
      const data =
        event.data && typeof event.data === 'object' ? (event.data as Record<string, any>) : {}
      const step = data.step ?? steps.get(data.stepId ?? data.gate?.stepId)
      const correctedControl =
        event.type === 'human.intervention' && correctedControls.has(data.intervention?.id)
      const human = isHumanEvent(event) && !correctedControl
      const checks = Array.isArray(data.results)
        ? data.results
            .filter(
              (check: any) => typeof check?.name === 'string' && typeof check?.passed === 'boolean',
            )
            .map((check: any) => ({
              name: check.name,
              passed: check.passed,
              detail: readable(check.detail),
            }))
        : []
      let tone: EventTone = human ? 'human' : 'neutral'
      if (
        ['gate.pending', 'gate.expired', 'run.interrupted', 'review.invalidated'].includes(
          event.type,
        )
      )
        tone = 'attention'
      if (
        ['run.error', 'run.failed', 'review.failed'].includes(event.type) ||
        data.status === 'failed'
      )
        tone = 'error'
      if (event.type === 'verification.completed' && checks.length)
        tone = checks.every((check: { passed: boolean }) => check.passed) ? 'verified' : 'error'
      let title = titles[event.type] ?? '执行记录'
      if (event.type === 'human.intervention' && data.intervention?.action in actionLabels)
        title = actionLabels[data.intervention.action as keyof typeof actionLabels]
      if (event.type === 'tool.proposed' && step?.tool) title = tools[step.tool] ?? title
      if (event.type === 'tool.finished' && data.status !== 'done') title = '动作执行结束'
      if (event.type === 'run.settled' && data.status === 'stopped') title = '任务已停止'
      if (correctedControl) title = '继续任务'
      const requirements = Array.isArray(data.constraints)
        ? data.constraints
            .map((constraint: any) =>
              typeof constraint === 'string' ? constraint : readable(constraint?.text),
            )
            .filter(Boolean)
        : []
      let summary =
        readable(data.intervention?.text) ||
        readable(data.message) ||
        readable(data.text) ||
        readable(data.reason) ||
        readable(step?.args?.intent) ||
        readable(data.path) ||
        readable(step?.args?.path) ||
        readable(data.prompt) ||
        readable(data.reflection)
      if (summary === 'The operation was aborted due to timeout') summary = '该次模型请求超时。'
      if (event.type === 'constraints.confirmed') summary = `已确认 ${requirements.length} 条要求`
      if (event.type === 'grill.updated')
        summary = data.status === 'confirm' ? '整理确认清单' : `第 ${data.round} 轮澄清`
      if (event.type === 'model.request') summary = run.workerLabel
      if (
        correctedControl ||
        ['run.resume-requested', 'run.explicit-continuation'].includes(event.type)
      )
        summary = '继续执行当前任务'
      if (checks.length)
        summary = `${checks.filter((check: { passed: boolean }) => check.passed).length} / ${checks.length} 项检查通过`
      const fields: TimelineEntry['fields'] = []
      if (step?.tool) fields.push({ label: '动作', value: tools[step.tool] ?? step.tool })
      const file = readable(data.path) || readable(step?.args?.path)
      if (file) fields.push({ label: '文件', value: file })
      if (data.status && data.status in stepLabels)
        fields.push({ label: '结果', value: stepLabels[data.status as keyof typeof stepLabels] })
      if (typeof data.number === 'number')
        fields.push({ label: '请求', value: `第 ${data.number} 次` })
      if (typeof data.revision === 'number')
        fields.push({ label: '要求版本', value: `v${data.revision}` })
      if (typeof data.bytes === 'number')
        fields.push({ label: '文件大小', value: `${Math.ceil(data.bytes / 1024)} KB` })
      return {
        event,
        title,
        summary,
        tone,
        fields,
        requirements,
        checks,
        category: human
          ? '你的操作'
          : event.type.startsWith('verification.')
            ? '验证'
            : event.type.startsWith('tool.') || event.type === 'artifact.written'
              ? '执行动作'
              : '运行进展',
      }
    })
}
