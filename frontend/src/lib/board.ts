import type {
  Decision,
  Gate,
  RunState,
  Step,
  Verification,
} from '../../../decision-desk/shared/types.js'

export type Lane = 'attention' | 'active' | 'validation' | 'verified' | 'closed'
export interface BoardItem {
  id: string
  title: string
  summary: string
  decision?: Decision
  steps: Step[]
  gate?: Gate
  lane: Lane
  tone: 'red' | 'blue' | 'neutral' | 'green'
  checks: Verification[]
}
export const laneLabels: Record<Lane, string> = {
  attention: '需要你判断',
  active: '正在推进',
  validation: '等待验证',
  verified: '已验证',
  closed: '已停止与已拦停',
}
export const humanLabels = {
  unreviewed: '未审阅',
  acknowledged: '已认可',
  corrected: '已纠正',
  'allowed-once': '仅本次允许',
}
export const stepLabels: Record<Step['status'], string> = {
  reviewing: '审查中',
  waiting: '等待判断',
  executing: '执行中',
  done: '已执行',
  denied: '已拦停',
  failed: '执行失败',
  cancelled: '已取消',
}
export const progressLabels = {
  recorded: '已记录',
  delivered: '已传达给 Agent',
  acted: '已产生后续改动',
  verified: '对应检查已通过',
}
export const actionLabels = {
  correct: '改成另一种做法',
  enforce: '按原要求改正',
  'allow-once': '仅本次允许',
  acknowledge: '认可',
  stop: '停止任务',
  followup: '补充要求',
}
export const isActive = (run: RunState) => ['running', 'waiting', 'stopping'].includes(run.status)
export const isReadOnly = (run: RunState) =>
  ['stopped', 'stopping', 'error', 'interrupted'].includes(run.status)

export function currentChecks(run: RunState) {
  const latest = new Map<string, Verification>()
  for (const check of run.verifications) latest.set(`${check.path}:${check.name}`, check)
  return [...latest.values()].map((check) => ({
    ...check,
    stale:
      check.stale ||
      !run.files.some((file) => file.path === check.path && file.hash === check.artifactHash) ||
      !run.steps.some(
        (step) =>
          step.id === check.stepId &&
          step.status === 'done' &&
          step.tool === 'verify_app' &&
          step.args.path === check.path,
      ),
  }))
}
function boundChecks(run: RunState, stepIds: string[]) {
  return currentChecks(run).filter(
    (check) =>
      stepIds.includes(check.stepId) &&
      run.steps.some(
        (step) => step.id === check.stepId && step.status === 'done' && step.tool === 'verify_app',
      ),
  )
}
export function boardItems(run: RunState): BoardItem[] {
  const items: BoardItem[] = []
  for (const decision of run.decisions) {
    const allSteps = run.steps.filter((step) => decision.stepIds.includes(step.id))
    if (decision.review.source === 'system' && decision.review.topic === 'review-failure') {
      items.push({
        id: decision.id,
        title: '审查服务未完成',
        summary: /timeout|超时|响应超过/i.test(decision.review.summary)
          ? '审查服务超时，本次动作未执行。'
          : decision.review.summary,
        steps: allSteps,
        lane: 'closed',
        tone: 'neutral',
        checks: [],
      })
      continue
    }
    const pendingGates = run.gates.filter(
      (gate) => gate.decisionId === decision.id && gate.status === 'pending',
    )
    const correction = run.interventions
      .filter(
        (entry) =>
          entry.decisionId === decision.id && ['correct', 'enforce'].includes(entry.action),
      )
      .at(-1)
    const paths = new Set(
      run.steps
        .filter((step) => correction?.subsequentStepIds.includes(step.id))
        .map((step) => step.args.path),
    )
    const checks =
      correction?.progress === 'verified'
        ? boundChecks(
            run,
            run.steps
              .filter(
                (step) =>
                  step.tool === 'verify_app' &&
                  step.createdAt >= correction.createdAt &&
                  paths.has(step.args.path),
              )
              .map((step) => step.id),
          )
        : []
    const verified = checks.length > 0 && checks.every((check) => check.passed && !check.stale)
    for (const gate of pendingGates.length ? pendingGates : [undefined]) {
      const steps = gate ? allSteps.filter((step) => step.id === gate.stepId) : allSteps
      const moving = steps.some((step) => ['reviewing', 'executing'].includes(step.status))
      const closed =
        isReadOnly(run) ||
        (!correction &&
          steps.length > 0 &&
          steps.every((step) => ['cancelled', 'denied', 'failed'].includes(step.status)))
      const lane: Lane = gate
        ? 'attention'
        : verified
          ? 'verified'
          : closed
            ? 'closed'
            : moving ||
                (correction &&
                  ['recorded', 'delivered'].includes(correction.progress) &&
                  isActive(run))
              ? 'active'
              : 'validation'
      items.push({
        id: gate?.id ?? decision.id,
        title: verified ? '纠正已通过对应检查' : decision.review.title,
        summary: verified
          ? `原问题：${decision.review.title}。后续改动的 ${checks.length} 项当前检查通过。`
          : decision.review.summary,
        decision,
        steps,
        gate,
        lane,
        checks,
        tone:
          lane === 'verified'
            ? 'green'
            : ['conflict', 'uncertain'].includes(decision.review.classification)
              ? 'red'
              : 'blue',
      })
    }
  }
  for (const step of run.steps.filter(
    (entry) => !entry.decisionId && !['read_file', 'list_files'].includes(entry.tool),
  )) {
    const checks = boundChecks(run, [step.id])
    const verified = checks.length > 0 && checks.every((check) => check.passed && !check.stale)
    const lane: Lane = ['reviewing', 'executing'].includes(step.status)
      ? 'active'
      : step.status === 'waiting'
        ? 'attention'
        : verified
          ? 'verified'
          : ['cancelled', 'denied', 'failed'].includes(step.status)
            ? 'closed'
            : 'validation'
    items.push({
      id: step.id,
      title: step.review?.title ?? String(step.args.intent ?? '执行项目步骤'),
      summary:
        step.tool === 'verify_app'
          ? '检查结果与当前文件内容绑定。'
          : (step.review?.summary ?? String(step.args.path ?? step.tool)),
      steps: [step],
      lane,
      checks,
      tone: verified ? 'green' : 'neutral',
    })
  }
  return items
}
