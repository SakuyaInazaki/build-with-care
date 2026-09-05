/** LLM-line compatibility exports. The stream owns the single work-unit contract. */
export {
  DOMAIN_MEMBERS, domainOfChoice, extractDecisions, isConstraintConflict, matchDecisions,
  normalizeChoice, normalizeDecision, normalizeDomain, structureConstraint, structureSpecConstraints,
  verdictForUnit,
} from '../work-unit.js'
export type {
  DecisionMatch, StructuredConstraint, StructuredDecision, WorkUnitInput,
} from '../types.js'
export type { ActionInput, ConfirmedSpec, Verdict, VerdictKind } from '../types.js'

import type { ActionInput, DecisionMatch, FailureKind, StructuredConstraint, VerdictKind } from '../types.js'
import { verdictForUnit } from '../work-unit.js'
import type { WorkUnitInput } from '../types.js'

export type MatchOutcome = DecisionMatch['outcome']
export const MATCH_OUTCOMES: readonly MatchOutcome[] = ['forbidden', 'required-mismatch', 'required-match', 'preference-mismatch', 'human-specified', 'unconstrained']
export interface UnitVerdict { kind: VerdictKind; explanation: string; alternatives: string[]; matches: DecisionMatch[]; failureKind?: FailureKind }
export const isRedOutcome = (outcome: MatchOutcome): boolean => outcome === 'forbidden' || outcome === 'required-mismatch'
export function kindFromMatches(matches: readonly DecisionMatch[]): VerdictKind | undefined {
  if (!matches.length) return undefined
  return matches.some((item) => isRedOutcome(item.outcome)) ? 'red' : matches.some((item) => item.outcome === 'preference-mismatch' || item.outcome === 'unconstrained') ? 'blue' : 'gray'
}
export function verdictFromMatches(matches: readonly DecisionMatch[], options: { toolCalls?: readonly ActionInput[]; constraints?: readonly StructuredConstraint[] } = {}): UnitVerdict {
  const unit: WorkUnitInput = { goal: '', decisions: matches.map((item) => item.decision), toolCalls: [...(options.toolCalls ?? [])] }
  return { ...verdictForUnit(unit, [...matches], options.constraints ?? []), matches: [...matches] }
}
export const renderConstraint = (constraint: StructuredConstraint): string => `${constraint.domain} · ${constraint.kind} · [${constraint.values.join(', ')}] ——「${constraint.text}」`
export const renderDecision = (decision: DecisionMatch['decision']): string => `${decision.domain} = ${decision.choice}${decision.specifiedByHuman ? '（agent 称人指定，需核实）' : ''}${decision.extracted ? '（从工具调用推断）' : ''}${decision.rationale ? `：${decision.rationale}` : ''}`
