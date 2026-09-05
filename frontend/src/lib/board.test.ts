import { describe, expect, it } from 'vitest'
import type { RunState, Review, Step } from '../../../decision-desk/shared/types.js'
import { boardItems, currentChecks } from './board.js'

const at = '2026-09-05T10:00:00.000Z'
const review: Review = {
  classification: 'choice',
  title: '布局选择',
  summary: '使用单栏',
  impact: '',
  constraintIds: [],
  evidence: '',
  options: [],
  topic: 'layout',
  source: 'independent-model',
}
const step = (id: string, tool = 'write_file'): Step => ({
  id,
  callId: id,
  tool,
  args: { path: 'index.html' },
  revision: 1,
  createdAt: at,
  status: 'done',
})
const fixture = (): RunState => ({
  id: 'run',
  title: '任务',
  prompt: '一个页面',
  mode: 'live',
  status: 'running',
  createdAt: at,
  updatedAt: at,
  revision: 1,
  constraints: [],
  steps: [step('write'), step('check', 'verify_app')],
  decisions: [],
  gates: [],
  interventions: [],
  verifications: [
    {
      id: 'evidence',
      stepId: 'check',
      path: 'index.html',
      artifactHash: 'hash-1',
      name: '静态检查',
      passed: true,
      stale: false,
      detail: '通过',
      createdAt: at,
    },
  ],
  files: [{ path: 'index.html', hash: 'hash-1', bytes: 20 }],
  messages: [],
  reflection: '',
  lastEventSeq: 1,
  runtime: 'test',
  workerLabel: 'test',
  reviewerLabel: 'test',
})

describe('evidence and state lanes', () => {
  it('links current file checks to completed units including ordinary decision cards, without treating approval as proof', () => {
    const run = fixture()
    run.steps[0].unitId = 'old-unit'
    run.steps[1].unitId = 'new-unit'
    run.workUnits = [{ id: 'old-unit', goal: '骨架', status: 'completed', decisions: [], plan: [], nextCall: 0, stepIds: ['write'], revision: 1, createdAt: at }]
    run.decisions = [{ id: 'decision', unitId: 'old-unit', stepIds: ['write'], review, revision: 1, createdAt: at, humanStatus: 'unreviewed', executionStatus: 'done' }]
    let card = boardItems(run).find(card => card.id === 'decision')!
    expect(card.lane).toBe('verified')
    expect(card.decision?.humanStatus).toBe('unreviewed')
    expect(card.checks[0].stepId).toBe('check')
    run.files[0].hash = 'changed'
    card = boardItems(run).find(card => card.id === 'decision')!
    expect(card.lane).toBe('validation')
    expect(card.checks[0].stale).toBe(true)
    run.files[0].hash = 'hash-1'
    run.verifications[0].revision = 0
    expect(boardItems(run).find(card => card.id === 'decision')?.lane).toBe('validation')
  })
  it('groups a completed work unit into one card without claiming untested work is verified', () => {
    const run = fixture()
    run.steps = ['begin', 'write', 'end'].map((id) => ({
      ...step(id, id === 'write' ? 'write_file' : `${id}_unit`),
      unitId: 'unit',
    }))
    run.workUnits = [
      {
        id: 'unit',
        goal: '完成课程编辑',
        decisions: [],
        plan: [{ tool: 'write_file', path: 'index.html' }],
        nextCall: 1,
        stepIds: run.steps.map((s) => s.id),
        revision: 1,
        status: 'completed',
        createdAt: at,
        summary: '已写入课程编辑页面',
      },
    ]
    const cards = boardItems(run)
    expect(cards).toHaveLength(1)
    expect(cards[0].title).toBe('完成课程编辑')
    expect(cards[0].steps).toHaveLength(3)
    expect(cards[0].lane).toBe('validation')
    expect(cards[0].tone).toBe('neutral')
  })
  it('never treats execution or human acknowledgement as verification', () => {
    const run = fixture()
    run.decisions = [
      {
        id: 'd',
        stepIds: ['write'],
        review,
        revision: 1,
        createdAt: at,
        humanStatus: 'acknowledged',
        executionStatus: 'done',
      },
    ]
    run.steps[0].decisionId = 'd'
    const card = boardItems(run).find((item) => item.id === 'd')!
    expect(card.tone).toBe('blue')
    expect(card.lane).toBe('validation')
  })
  it('exposes every pending gate even when one decision groups multiple calls', () => {
    const run = fixture()
    run.decisions = [
      {
        id: 'd',
        stepIds: ['a', 'b'],
        review: { ...review, classification: 'conflict' },
        revision: 1,
        createdAt: at,
        humanStatus: 'unreviewed',
        executionStatus: 'waiting',
      },
    ]
    run.steps = ['a', 'b'].map((id) => ({ ...step(id), decisionId: 'd', status: 'waiting' }))
    run.gates = ['a', 'b'].map((id) => ({
      id: `gate-${id}`,
      stepId: id,
      decisionId: 'd',
      revision: 1,
      argsHash: id,
      status: 'pending',
      expiresAt: '2026-09-05T10:10:00.000Z',
    }))
    expect(boardItems(run).map((item) => [item.id, item.lane, item.steps[0].id])).toEqual([
      ['gate-a', 'attention', 'a'],
      ['gate-b', 'attention', 'b'],
    ])
  })
  it('invalidates a passed check when its file changes or its executing step is missing', () => {
    const run = fixture()
    expect(currentChecks(run)[0].stale).toBe(false)
    run.files[0].hash = 'hash-2'
    expect(currentChecks(run)[0].stale).toBe(true)
    run.files[0].hash = 'hash-1'
    run.steps = [step('write')]
    expect(currentChecks(run)[0].stale).toBe(true)
  })
  it('uses the latest failed check instead of an earlier pass', () => {
    const run = fixture()
    run.verifications.push({ ...run.verifications[0], id: 'failed', passed: false })
    expect(currentChecks(run)).toHaveLength(1)
    expect(boardItems(run).find((item) => item.id === 'check')?.lane).toBe('validation')
  })
  it('requires both a correction link and current executor evidence to turn a correction green', () => {
    const run = fixture()
    run.decisions = [
      {
        id: 'd',
        stepIds: ['original'],
        review: { ...review, classification: 'conflict' },
        revision: 1,
        createdAt: at,
        humanStatus: 'corrected',
        executionStatus: 'denied',
      },
    ]
    run.interventions = [
      {
        id: 'i',
        requestId: 'request',
        decisionId: 'd',
        action: 'enforce',
        text: '按原要求',
        fromRevision: 1,
        toRevision: 2,
        createdAt: at,
        progress: 'verified',
        subsequentStepIds: ['write'],
      },
    ]
    expect(boardItems(run).find((item) => item.id === 'd')?.lane).toBe('verified')
    run.files[0].hash = 'changed'
    expect(boardItems(run).find((item) => item.id === 'd')?.lane).toBe('validation')
    run.files[0].hash = 'hash-1'
    run.interventions[0].subsequentStepIds = []
    expect(boardItems(run).find((item) => item.id === 'd')?.lane).toBe('validation')
  })
})
