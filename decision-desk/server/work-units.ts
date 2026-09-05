import { randomUUID } from 'node:crypto'
import { z } from 'zod'
// Reuse the existing rule implementation instead of maintaining a second policy engine.
import {
  extractDecisions,
  isConstraintConflict,
  matchDecisions,
  normalizeDecision,
  structureConstraint,
} from '../../src/work-unit.js'
import type { RunState, WorkUnit, Review } from '../shared/types.js'

const declaration = z.object({
  goal: z.string().trim().min(1),
  decisions: z.array(
    z.object({
      domain: z.string().min(1),
      choice: z.string().min(1),
      rationale: z.string().optional(),
      specifiedByHuman: z.boolean().optional(),
    }),
  ),
  plan: z.array(z.object({ tool: z.string().min(1), path: z.string().min(1).optional() })).min(1),
})
const localWrites = new Set(['write_file', 'edit_file'])
export const unitControls = new Set(['begin_unit', 'end_unit'])
export const prohibitedTools = new Set([
  'ask_user_question',
  'spawn_agent',
  'spawn_subagent',
  'spawn',
  'fork_agent',
])

export function activeUnit(state: RunState) {
  return state.workUnits?.find((unit) => unit.status === 'active' || unit.status === 'declared')
}
export function declareUnit(state: RunState, input: unknown, knownTools: string[]): WorkUnit {
  if (activeUnit(state)) throw new Error('当前工作单元尚未结束，请先完成并调用 end_unit。')
  const parsed = declaration.safeParse(input)
  if (!parsed.success) throw new Error('工作单元声明不完整，需要 goal、decisions 和 plan。')
  for (const call of parsed.data.plan) {
    if (
      unitControls.has(call.tool) ||
      prohibitedTools.has(call.tool) ||
      !knownTools.includes(call.tool)
    )
      throw new Error(`工作单元包含不可用工具：${call.tool}`)
    if (localWrites.has(call.tool) && !call.path)
      throw new Error('写入计划必须声明明确的文件路径。')
  }
  const unit: WorkUnit = {
    ...parsed.data,
    decisions: parsed.data.decisions.map((value) => normalizeDecision(value)!),
    id: randomUUID(),
    revision: state.revision,
    stepIds: [],
    nextCall: 0,
    status: 'declared',
    createdAt: new Date().toISOString(),
  }
  ;(state.workUnits ??= []).push(unit)
  return unit
}
export function checkUnitScope(
  state: RunState,
  tool: string,
  args: Record<string, unknown>,
): WorkUnit | undefined {
  const unit = activeUnit(state)
  if (!unit) {
    if (state.workUnitProtocol && !['read_file', 'list_files'].includes(tool))
      throw new Error('请先调用 begin_unit 声明语义目标、决策及工具计划，再执行修改或验证。')
    return undefined
  }
  if (unit.status !== 'active') throw new Error('工作单元尚未通过审查。')
  // Reads used to correct a failed edit are allowed without broadening its write scope.
  if (['read_file', 'list_files'].includes(tool)) return unit
  const planned = unit.plan[unit.nextCall]
  if (!planned || planned.tool !== tool || (planned.path && planned.path !== args.path))
    throw new Error(
      `调用 ${tool} ${String(args.path ?? '')} 超出已声明工作单元；请结束当前单元并重新声明。`,
    )
  for (const actual of extractDecisions({ tool, kind: 'write', description: '', args })) {
    const declared = unit.decisions.filter((decision) => decision.domain === actual.domain)
    if (declared.length && !declared.some((decision) => decision.choice === actual.choice))
      throw new Error(
        `实际调用选择了 ${actual.domain}=${actual.choice}，与工作单元声明不一致。请取消当前单元并重新声明实际方案。`,
      )
  }
  return unit
}
export function closeUnit(state: RunState, summary: string, cancelled = false) {
  const unit = activeUnit(state)
  if (!unit) throw new Error('没有正在进行的工作单元。')
  if (
    state.steps.some(
      (step) =>
        step.unitId === unit.id &&
        !unitControls.has(step.tool) &&
        ['waiting', 'reviewing', 'executing'].includes(step.status),
    )
  )
    throw new Error('工作单元仍有未结束调用，不能关闭。')
  if (!cancelled && unit.nextCall !== unit.plan.length)
    throw new Error('工作单元还有未完成计划；请继续执行，或明确取消本单元。')
  unit.status = cancelled ? 'cancelled' : 'completed'
  unit.summary = summary
  unit.closedAt = new Date().toISOString()
  return unit
}
export function cancelUnits(state: RunState) {
  for (const unit of state.workUnits ?? [])
    if (['active', 'declared'].includes(unit.status)) {
      unit.status = 'cancelled'
      unit.closedAt = new Date().toISOString()
    }
}
export function unitPolicy(
  state: RunState,
  tool: string,
  args: Record<string, unknown>,
  unit?: WorkUnit,
): Review | undefined {
  if (['read_file', 'list_files', 'verify_app', 'end_unit'].includes(tool)) return undefined
  const active = state.constraints.filter((c) => c.active)
  const structured = active.flatMap((c) =>
    structureConstraint(c.text, { id: c.id, source: 'spec' }).map((rule) => ({
      ...rule,
      id: c.id,
    })),
  )
  const decisions = [
    ...(unit?.decisions ?? []),
    ...extractDecisions({ tool, kind: 'write', description: '', args }),
  ]
  const conflicts = matchDecisions(decisions, structured, {
    request: state.prompt,
    constraintTexts: active.map((c) => c.text),
  }).filter((match) => isConstraintConflict(match.outcome))
  if (!conflicts.length) return undefined
  return {
    classification: 'conflict',
    title: '工作单元与已确认要求冲突',
    summary: conflicts.map((match) => match.explanation).join('；'),
    impact: '本次动作需纠正或由人明确处理后才能执行。',
    constraintIds: [...new Set(conflicts.map((match) => match.constraintId!))],
    evidence: conflicts.map((match) => match.explanation).join('\n'),
    options: ['按原要求改正'],
    topic: 'unit-policy',
    source: 'system',
  }
}
