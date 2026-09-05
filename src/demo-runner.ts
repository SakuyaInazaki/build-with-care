import type { DemoScenario, Runner, RunnerStage, RunnerStatus } from './runner-types.js'
import type { DecisionStream } from './stream.js'
import { demoPlan } from './ui-flow.js'
import type { ActionInput, ActionResult, DecisionCard, WorkUnitInput } from './types.js'

export interface DemoRunnerOptions {
  scenario: DemoScenario
  /** Milliseconds between stages; tests pass a tiny value. */
  pace?: number
}

class DemoCancelled extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'DemoCancelled'
  }
}

export const DEMO_SCENARIOS: DemoScenario[] = ['full', 'multi-agent', 'red-only']

const DEMO_SCHEMA = '-- demo schema (Postgres 兼容)\nCREATE TABLE registrations (\n  id text PRIMARY KEY,\n  name text NOT NULL,\n  created_at timestamptz DEFAULT now()\n);\n'

/**
 * Scripted, model-free demo driver. It only calls the public `DecisionStream` API, so every card it produces
 * is judged, recorded, gated and executed exactly like a real agent's action would be.
 */
export class DemoRunner implements Runner {
  status: RunnerStatus
  private readonly listeners = new Set<(status: RunnerStatus) => void>()
  private readonly controller = new AbortController()
  private readonly pace: number
  private readonly scenario: DemoScenario
  private unsubscribe?: () => void

  constructor(private readonly stream: DecisionStream, options: DemoRunnerOptions) {
    this.scenario = options.scenario
    this.pace = Math.max(0, options.pace ?? 900)
    this.status = { kind: 'demo', state: 'idle', scenario: options.scenario, stages: this.initialStages(), steps: 0 }
  }

  subscribe(listener: (status: RunnerStatus) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  cancel(reason = '演示已被叫停'): void {
    if (this.controller.signal.aborted) return
    this.controller.abort(new DemoCancelled(reason))
  }

  async start(): Promise<void> {
    if (this.status.state !== 'idle') return
    this.update({ state: 'running', startedAt: new Date().toISOString(), message: `脚本演示「${this.scenario}」开始` })
    this.stream.recordRunnerEvent(`脚本演示「${this.scenario}」开始`, { scenario: this.scenario, pace: this.pace })
    this.unsubscribe = this.stream.subscribe((event) => {
      if (event.type === 'session-end') this.cancel('会话已结束')
    })
    try {
      if (this.scenario === 'full') await this.runFull()
      else if (this.scenario === 'multi-agent') await this.runMultiAgent()
      else await this.runRedOnly()
      const report = this.stream.report()
      this.update({ state: 'done', finishedAt: new Date().toISOString(), waitingCardId: undefined, message: report.summary })
      this.stream.recordRunnerEvent(`脚本演示「${this.scenario}」完成`, { scenario: this.scenario, steps: this.status.steps })
    } catch (error) {
      const cancelled = error instanceof DemoCancelled || this.controller.signal.aborted
      const message = error instanceof Error ? error.message : String(error)
      this.markActiveStage(cancelled ? 'skipped' : 'failed')
      this.update({ state: cancelled ? 'cancelled' : 'failed', finishedAt: new Date().toISOString(), waitingCardId: undefined, message: cancelled ? `演示已取消：${message}` : `演示失败：${message}` })
      if (!this.stream.ended) this.stream.recordRunnerEvent(cancelled ? `脚本演示已取消：${message}` : `脚本演示失败：${message}`, { scenario: this.scenario, cancelled })
    } finally {
      this.unsubscribe?.()
    }
  }

  // ---------------------------------------------------------------------------
  // Scenarios
  // ---------------------------------------------------------------------------

  private async runFull(): Promise<void> {
    this.stage('blue')
    await this.actUnit({ id: 'demo-blue', goal: '选择缓存方案', decisions: [{ domain: 'cache', choice: 'memory-cache' }], toolCalls: [{ tool: 'choose_cache', kind: 'write', description: '选择内存缓存方案', args: { provider: 'memory' }, agentId: 'agent-research' }] })
    await this.sleep()

    this.stage('red')
    const red = await this.actUnitWaitingForHuman({ id: 'demo-red', goal: '为报名信息选择并落地存储', decisions: [{ domain: 'storage', choice: 'sqlite' }], toolCalls: [{ tool: 'write_file', kind: 'write', description: '选择 SQLite 存储报名信息', args: { path: 'store/db.sqlite', content: '' }, agentId: 'agent-builder' }] })
    await this.sleep()

    if (red.card.state === 'cancelled') throw new DemoCancelled(red.reason ?? '红卡已被叫停')
    if (red.allowed) {
      this.stage('correction', 'skipped')
      this.note('人放行了 SQLite 写入，未纠偏，继续后续步骤')
    } else {
      this.stage('correction')
      this.note(this.stream.mode === 'forward-only' ? `forward-only 已注入后续约束：${red.card.appliedConstraint ?? ''}` : `rewind-and-fork 已保留原分支并 fork 到 ${red.branchId ?? ''}`)
      await this.sleep()
    }

    this.stage('tool')
    await this.actUnit({ id: 'demo-postgres', goal: '按人的裁决落地 Postgres 存储', decisions: [{ domain: 'storage', choice: 'postgres', specifiedByHuman: true }], toolCalls: [{ tool: 'write_file', kind: 'write', description: '使用 Postgres 兼容 schema 保存报名信息', args: { path: 'store/db.sql', content: DEMO_SCHEMA }, specified: true, agentId: 'agent-builder' }] })
    await this.sleep()

    this.stage('evidence')
    await this.actUnit({ id: 'demo-evidence', goal: '验证报名 schema', decisions: [], toolCalls: [{ tool: 'local_check', kind: 'validate', description: '运行报名 schema 本地检查', args: { target: 'store/db.sql' }, specified: true, agentId: 'agent-verifier' }] })
    await this.sleep()

    this.stage('runtime-failure')
    const test = await this.actUnit({ id: 'demo-test', goal: '运行测试验证核心流程', decisions: [], toolCalls: [{ tool: 'run_command', kind: 'command', description: '在工作区运行 npm test 验证核心流程', args: { command: 'npm test' }, specified: true, agentId: 'agent-verifier' }] })
    this.note(test.card.blockedHelp ? `npm test 连续失败 ${test.card.runtimeAttempts} 次，已升级为阻塞求助` : 'npm test 已执行')
    await this.sleep()

    this.stage('complete')
    this.markActiveStage('done')
  }

  private async runMultiAgent(): Promise<void> {
    const research = async () => {
      this.stage('agent-research')
      await this.act({ id: 'ma-research-read', tool: 'read_file', kind: 'read', description: '读取需求说明', args: { path: 'README.md' }, specified: true, agentId: 'agent-research' })
      await this.sleep(0.6)
      await this.act({ id: 'ma-research-cache', tool: 'choose_cache', kind: 'write', description: '选择内存缓存方案', args: { provider: 'memory' }, agentId: 'agent-research' })
      await this.sleep(0.9)
      await this.act({ id: 'ma-research-check', tool: 'local_check', kind: 'validate', description: '核对缓存方案与需求一致', args: { target: 'cache' }, specified: true, agentId: 'agent-research' })
      this.stage('agent-research', 'done')
    }
    const builder = async () => {
      await this.sleep(0.3)
      this.stage('agent-builder')
      await this.act({ id: 'ma-builder-notes', tool: 'write_file', kind: 'write', description: '写入实现笔记', args: { path: 'notes/plan.md', content: '# plan\n' }, specified: true, agentId: 'agent-builder' })
      await this.sleep(0.5)
      const red = await this.actWaitingForHuman({ id: 'demo-red', tool: 'write_file', kind: 'write', description: '选择 SQLite 存储报名信息', args: { path: 'store/db.sqlite', content: '' }, agentId: 'agent-builder' })
      if (red.card.state === 'cancelled') throw new DemoCancelled(red.reason ?? '红卡已被叫停')
      await this.sleep(0.4)
      await this.act({ id: 'ma-builder-schema', tool: 'write_file', kind: 'write', description: '写入 Postgres 兼容 schema', args: { path: 'store/db.sql', content: DEMO_SCHEMA }, specified: true, agentId: 'agent-builder' })
      this.stage('agent-builder', 'done')
    }
    const verifier = async () => {
      await this.sleep(0.5)
      this.stage('agent-verifier')
      await this.act({ id: 'ma-verifier-check', tool: 'local_check', kind: 'validate', description: '检查工作区结构', args: { target: 'workspace' }, specified: true, agentId: 'agent-verifier' })
      await this.sleep(0.7)
      await this.act({ id: 'ma-verifier-framework', tool: 'choose_test_framework', kind: 'write', description: '选择 vitest 作为测试框架', args: { framework: 'vitest' }, agentId: 'agent-verifier' })
      await this.sleep(0.6)
      await this.act({ id: 'ma-verifier-evidence', tool: 'local_check', kind: 'validate', description: '运行 schema 本地检查', args: { target: 'store/db.sql' }, specified: true, agentId: 'agent-verifier' })
      this.stage('agent-verifier', 'done')
    }
    await Promise.all([research(), builder(), verifier()])
  }

  private async runRedOnly(): Promise<void> {
    this.stage('red')
    const red = await this.actWaitingForHuman({ id: 'demo-red', tool: 'write_file', kind: 'write', description: '选择 SQLite 存储', args: { path: 'store/db.sqlite', content: '' }, agentId: 'demo-agent' })
    if (red.card.state === 'cancelled') throw new DemoCancelled(red.reason ?? '红卡已被叫停')
    this.markActiveStage('done')
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private initialStages(): RunnerStage[] {
    if (this.scenario === 'full') return demoPlan(this.stream.mode).map((item) => ({ id: item.stage, label: item.label, status: 'pending' }))
    if (this.scenario === 'multi-agent') {
      return [
        { id: 'agent-research', label: 'agent-research：读取 / 选缓存 / 核对', status: 'pending' },
        { id: 'agent-builder', label: 'agent-builder：写笔记 / SQLite 红卡 / schema', status: 'pending' },
        { id: 'agent-verifier', label: 'agent-verifier：检查 / 选测试框架 / 证据', status: 'pending' },
      ]
    }
    return [{ id: 'red', label: '红卡：SQLite 冲突，等待人裁决', status: 'pending' }]
  }

  private stage(id: string, status: RunnerStage['status'] = 'active'): void {
    this.throwIfCancelled()
    const sequential = this.scenario !== 'multi-agent'
    const stages = (this.status.stages ?? []).map((stage) => {
      if (stage.id === id) return { ...stage, status }
      // Sequential scenarios: moving on (even by skipping) closes whatever stage was active.
      if (sequential && stage.status === 'active') return { ...stage, status: 'done' as const }
      return stage
    })
    this.update({ stages, message: `阶段：${stages.find((stage) => stage.id === id)?.label ?? id}` })
  }

  private markActiveStage(status: RunnerStage['status']): void {
    const stages = (this.status.stages ?? []).map((stage) => (stage.status === 'active' ? { ...stage, status } : stage))
    this.update({ stages })
  }

  private note(message: string): void {
    this.update({ message })
    this.stream.recordRunnerEvent(message, { scenario: this.scenario })
  }

  private async act(action: ActionInput): Promise<ActionResult> {
    this.throwIfCancelled()
    const result = await this.stream.execute(action, { signal: this.controller.signal })
    this.update({ steps: (this.status.steps ?? 0) + 1 })
    this.throwIfCancelled()
    return result
  }

  private async actUnit(unit: WorkUnitInput): Promise<ActionResult> {
    this.throwIfCancelled()
    const result = await this.stream.executeUnit(unit, { signal: this.controller.signal })
    this.update({ steps: (this.status.steps ?? 0) + 1 })
    this.throwIfCancelled()
    return result
  }

  /** Red cards block: the runner reports `waiting-human` until the gate settles, then resumes. */
  private async actWaitingForHuman(action: ActionInput): Promise<ActionResult> {
    this.throwIfCancelled()
    const cardId = action.id ?? ''
    const pending = this.stream.execute(action, { signal: this.controller.signal })
    const card = await this.waitForCard(cardId, pending)
    if (card?.state === 'pending') {
      this.update({ state: 'waiting-human', waitingCardId: card.id, message: `红卡「${card.action.description}」阻断，等待人裁决` })
      this.stream.recordRunnerEvent(`演示在红卡 ${card.id} 处停下，等待人裁决`, { scenario: this.scenario, cardId: card.id }, card.agentId)
    }
    const result = await pending
    this.update({ state: 'running', waitingCardId: undefined, steps: (this.status.steps ?? 0) + 1 })
    this.throwIfCancelled()
    return result
  }

  private async actUnitWaitingForHuman(unit: WorkUnitInput): Promise<ActionResult> {
    this.throwIfCancelled()
    const cardId = unit.id ?? ''
    const pending = this.stream.executeUnit(unit, { signal: this.controller.signal })
    const card = await this.waitForCard(cardId, pending)
    if (card?.state === 'pending') {
      this.update({ state: 'waiting-human', waitingCardId: card.id, message: `红卡「${card.unit?.goal ?? card.action.description}」阻断，等待人裁决` })
      this.stream.recordRunnerEvent(`演示在红卡 ${card.id} 处停下，等待人裁决`, { scenario: this.scenario, cardId: card.id }, card.agentId)
    }
    const result = await pending
    this.update({ state: 'running', waitingCardId: undefined, steps: (this.status.steps ?? 0) + 1 })
    this.throwIfCancelled()
    return result
  }

  private async waitForCard(cardId: string, pending: Promise<ActionResult>): Promise<DecisionCard | undefined> {
    const existing = this.stream.cards.find((card) => card.id === cardId)
    if (existing) return existing
    return new Promise((resolve) => {
      const unsubscribe = this.stream.subscribe((event) => {
        if (event.type === 'card-created' && event.cardId === cardId) {
          unsubscribe()
          resolve(this.stream.cards.find((card) => card.id === cardId))
        }
      })
      void pending.then(() => { unsubscribe(); resolve(this.stream.cards.find((card) => card.id === cardId)) }, () => { unsubscribe(); resolve(undefined) })
    })
  }

  private sleep(factor = 1): Promise<void> {
    this.throwIfCancelled()
    const ms = Math.round(this.pace * factor)
    if (ms <= 0) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.controller.signal.removeEventListener('abort', onAbort); resolve() }, ms)
      const onAbort = () => { clearTimeout(timer); reject(this.controller.signal.reason) }
      this.controller.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private throwIfCancelled(): void {
    if (this.controller.signal.aborted) throw this.controller.signal.reason instanceof Error ? this.controller.signal.reason : new DemoCancelled(String(this.controller.signal.reason ?? '已取消'))
  }

  private update(patch: Partial<RunnerStatus>): void {
    this.status = { ...this.status, ...patch }
    for (const listener of this.listeners) {
      try { listener(this.status) } catch { /* listeners must not break the runner */ }
    }
  }
}
