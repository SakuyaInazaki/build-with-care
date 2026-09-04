import type { ActionInput, ConfirmedSpec, RecordingAssessment, RecorderInput, Verdict } from './types.js'

export interface JudgeInput { spec: ConfirmedSpec; action: ActionInput }
/** Decision judging and provenance recording are separate replacement seams. */
export interface DecisionJudge { judge(input: JudgeInput): Verdict | Promise<Verdict> }
export interface DecisionRecorder { assess(input: RecorderInput): RecordingAssessment | Promise<RecordingAssessment> }

export class DeterministicJudge implements DecisionJudge {
  judge({ spec, action }: JudgeInput): Verdict {
    if (action.specified) return { kind: 'gray', explanation: '该动作已明确，不打断。', alternatives: [] }
    const text = `${action.description} ${JSON.stringify(action.args)}`.toLowerCase()
    const conflict = spec.constraints.find((constraint) => {
      const terms = constraint.toLowerCase().match(/[a-z0-9]+/g) ?? []
      return terms.some((term) => term.length > 3 && text.includes(term)) && /(must|要求|必须|only|只能|不要|禁止|不允许|不得)/i.test(constraint)
    })
    if (conflict && /(sqlite|mongodb|mysql|english|javascript)/i.test(text)) {
      return { kind: 'red', explanation: `可能违反已确认 spec：“${conflict}”，请先裁决。`, alternatives: ['按已确认 spec 执行', '选择不同实现', '叫停当前任务'], failureKind: 'constraint-conflict' }
    }
    if (action.kind === 'read' || action.kind === 'validate') return { kind: 'gray', explanation: '纯执行或验证动作，不产生需要拍板的决策。', alternatives: [] }
    return { kind: 'blue', explanation: `spec 未指定${action.description}的具体方案，agent 自主选择了当前方案。`, alternatives: ['保留当前选择', '改用更保守的实现', '补充一条后续约束'] }
  }
}

export class DeterministicRecorder implements DecisionRecorder {
  assess({ action, humanInstruction }: RecorderInput): RecordingAssessment {
    const selfDirected = action.specified !== true
    const instruction = humanInstruction?.toLowerCase() ?? ''
    const actionText = `${action.description} ${JSON.stringify(action.args)}`.toLowerCase()
    const drift = Boolean(instruction && /(不要|禁止|must not|do not)/i.test(instruction) && /(sqlite|mongodb|mysql)/i.test(actionText))
    return { selfDirected, deviatesFromInstruction: drift, drift, confidence: drift ? 0.92 : 0.86, note: drift ? '动作与人类指令存在记录偏差' : selfDirected ? 'agent 自主选择，未阻断执行' : '动作来自明确指令' }
  }
}
