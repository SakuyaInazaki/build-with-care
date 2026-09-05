import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { AdditionInput, Mode, PublicSettings, RunState, Settings } from '../shared/types.js'
import { Store } from './store.js'
import { ConflictError, DecisionRuntime, type RuntimeOptions } from './engine.js'
import { completionUrl } from './models.js'

export const defaultSettings = (): Settings => ({
  worker: {
    baseUrl: process.env.WORKER_BASE_URL ?? 'https://api.deepseek.com/v1',
    model: process.env.WORKER_MODEL ?? 'deepseek-chat',
    family: process.env.WORKER_FAMILY ?? 'deepseek',
    apiKey: process.env.WORKER_API_KEY ?? '',
  },
  reviewer: {
    baseUrl: process.env.REVIEWER_BASE_URL ?? '',
    model: process.env.REVIEWER_MODEL ?? '',
    family: process.env.REVIEWER_FAMILY ?? '',
    apiKey: process.env.REVIEWER_API_KEY ?? '',
  },
  reviewTimeoutMs: 8000,
  gateTimeoutMs: 600000,
  demoDelayMs: 1000,
})
export class Manager {
  readonly store: Store
  readonly states = new Map<string, RunState>()
  readonly runtimes = new Map<string, DecisionRuntime>()
  readonly events = new EventEmitter()
  settings: Settings
  private continuing = new Set<string>()
  constructor(root: string, settings = defaultSettings()) {
    this.store = new Store(root)
    this.settings = settings
    for (const state of this.store.loadAll()) this.states.set(state.id, state)
    this.events.setMaxListeners(100)
  }
  publish = (state: RunState) => {
    this.events.emit('state', structuredClone(state))
  }
  list() {
    return [...this.states.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  get(id: string) {
    const state = this.states.get(id)
    if (!state) throw Object.assign(new Error('任务不存在'), { status: 404 })
    return state
  }
  publicSettings(): PublicSettings {
    const safe = ({ apiKey, ...model }: Settings['worker']) => ({ ...model, hasKey: !!apiKey })
    return {
      worker: safe(this.settings.worker),
      reviewer: safe(this.settings.reviewer),
      reviewTimeoutMs: this.settings.reviewTimeoutMs,
      gateTimeoutMs: this.settings.gateTimeoutMs,
      configured: this.configured(),
    }
  }
  configured() {
    return (
      [this.settings.worker, this.settings.reviewer].every(
        (c) =>
          c.baseUrl &&
          c.model &&
          c.family &&
          (c.apiKey || /^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(c.baseUrl)),
      ) && this.settings.worker.family.toLowerCase() !== this.settings.reviewer.family.toLowerCase()
    )
  }
  updateSettings(patch: {
    worker: Settings['worker']
    reviewer: Settings['reviewer']
    reviewTimeoutMs: number
  }) {
    completionUrl(patch.worker.baseUrl)
    completionUrl(patch.reviewer.baseUrl)
    if (patch.worker.family.toLowerCase() === patch.reviewer.family.toLowerCase())
      throw new Error('请为审查模型选择与执行模型不同的模型来源')
    for (const role of ['worker', 'reviewer'] as const) {
      const old = this.settings[role],
        next = patch[role]
      // An empty password only retains the credential for the very same endpoint.
      if (!next.apiKey && old.baseUrl === next.baseUrl) next.apiKey = old.apiKey
    }
    this.settings = { ...this.settings, ...patch }
    return this.publicSettings()
  }
  create(prompt: string, mode: Mode): RunState {
    if (mode === 'live' && !this.configured())
      throw new ConflictError('请先设置执行模型和异源审查模型')
    const at = new Date().toISOString(),
      id = randomUUID()
    const pieces = prompt
      .split(/[。；;\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
    const state: RunState = {
      id,
      prompt,
      title: prompt.slice(0, 28),
      mode,
      status: 'ready',
      createdAt: at,
      updatedAt: at,
      revision: 1,
      constraints: (pieces.length <= 5 ? pieces : [prompt]).map((text) => ({
        id: randomUUID(),
        text,
        source: text,
        revision: 1,
        active: true,
      })),
      steps: [],
      decisions: [],
      gates: [],
      interventions: [],
      verifications: [],
      messages: [],
      files: [],
      reflection: '',
      lastEventSeq: 0,
      runtime: 'dsh 0.1.2-rc.1 · 串行工具执行',
      workerLabel: mode === 'demo' ? '演示执行器' : this.settings.worker.model,
      reviewerLabel: mode === 'demo' ? '演示规则审查' : this.settings.reviewer.model,
    }
    this.states.set(id, state)
    this.store.append(state, 'run.created', { prompt, mode, constraints: state.constraints })
    this.store.save(state)
    this.publish(state)
    return state
  }
  async start(id: string, constraints: string[], options?: RuntimeOptions) {
    const state = this.get(id)
    if (state.status !== 'ready') throw new ConflictError('任务已经开始，不能重复启动')
    if (
      this.list().some((s) => s.id !== id && ['running', 'waiting', 'stopping'].includes(s.status))
    )
      throw new ConflictError('首版每次运行一个执行 Agent，请先结束当前任务')
    state.constraints = constraints.map((text) => ({
      id: randomUUID(),
      text,
      source: state.prompt.includes(text) ? text : '用户在开始前明确确认',
      revision: 1,
      active: true,
    }))
    const runtime = new DecisionRuntime(
      state,
      this.store,
      structuredClone(this.settings),
      this.publish,
      options,
    )
    this.runtimes.set(id, runtime)
    runtime.commit('constraints.confirmed', { constraints: state.constraints })
    await runtime.start()
    return state
  }
  async addInput(id: string, input: AdditionInput) {
    const state = this.get(id)
    const prior = state.interventions.find((i) => i.requestId === input.requestId)
    if (prior) return state
    if (input.revision !== state.revision) throw new ConflictError('要求已更新，请核对后重新提交')
    if (!input.text.trim()) throw new ConflictError('请写下要补充的内容')
    if (
      input.replaceConstraintId &&
      (input.kind !== 'requirement' ||
        !state.constraints.some((c) => c.id === input.replaceConstraintId && c.active))
    )
      throw new ConflictError('要替换的要求已失效，请重新选择')
    if (this.continuing.has(id) || state.status === 'stopping')
      throw new ConflictError('任务正在切换状态，请稍后重试')
    if (state.status === 'ready') throw new ConflictError('请先确认开始要求')
    if (
      this.list().some((s) => s.id !== id && ['running', 'waiting', 'stopping'].includes(s.status))
    )
      throw new ConflictError('另一个任务正在执行，请先结束它再继续本任务')
    const existing = this.runtimes.get(id)
    if (existing && !['stopped', 'error', 'interrupted'].includes(state.status)) {
      existing.addInput(input)
      return state
    }
    if (state.mode === 'live' && !this.configured())
      throw new ConflictError('请先配置两个模型，再继续这个任务')
    this.continuing.add(id)
    try {
      // Reserve the execution slot while an old runtime is disposed.
      const disposing = existing?.dispose()
      state.status = 'running'
      await disposing
      const runtime = new DecisionRuntime(
        state,
        this.store,
        structuredClone(this.settings),
        this.publish,
      )
      this.runtimes.set(id, runtime)
      state.error = undefined
      runtime.addInput(input)
      runtime.commit('run.explicit-continuation', {
        reason: '人明确追加了内容，基于现有文件开始新一轮；不重放旧工具。',
      })
      await runtime.start()
      return state
    } finally {
      this.continuing.delete(id)
    }
  }
  runtime(id: string) {
    this.get(id)
    const runtime = this.runtimes.get(id)
    if (!runtime)
      throw new ConflictError('旧决策不能重新放行。请在追加区补充新要求，基于现有成果继续。')
    return runtime
  }
  summary(id: string) {
    const state = this.get(id),
      latestChecks = state.verifications.filter((v) => !v.stale)
    const corrections = state.interventions.filter((i) => ['correct', 'enforce'].includes(i.action))
    return {
      decisions: state.decisions.length,
      unreviewed: state.decisions.filter((d) => d.humanStatus === 'unreviewed').length,
      acknowledged: state.decisions.filter((d) => d.humanStatus === 'acknowledged').length,
      corrections: corrections.length,
      additions: state.interventions.filter((i) => i.action === 'followup').length,
      withSubsequentActions: corrections.filter((i) => i.subsequentStepIds.length).length,
      checkedCorrections: corrections.filter((i) => i.progress === 'verified').length,
      allowedOnce: state.interventions.filter((i) => i.action === 'allow-once').length,
      checksPassed: latestChecks.filter((v) => v.passed).length,
      checksFailed: latestChecks.filter((v) => !v.passed).length,
      caveat: '未处理不等于批准；检查仅覆盖列出的范围，记录不构成能力评分。',
    }
  }
  async dispose() {
    await Promise.allSettled([...this.runtimes.values()].map((r) => r.dispose()))
  }
}
