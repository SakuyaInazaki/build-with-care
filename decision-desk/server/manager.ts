import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type {
  AdditionInput,
  GrillConfirmation,
  Mode,
  PublicSettings,
  RunState,
  Settings,
} from '../shared/types.js'
import { Store } from './store.js'
import { SettingsStore } from './settings-store.js'
import { ConflictError, DecisionRuntime, type RuntimeOptions } from './engine.js'
import { completionUrl } from './models.js'
import { confirmGrill, emptyGrill, nextGrill } from './grill.js'
import {
  DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  isDeepSeekBaseUrl,
} from '../shared/model-presets.js'

const modelDefaults = (role: 'WORKER' | 'REVIEWER'): Settings['worker'] => {
  const baseUrl = process.env[`${role}_BASE_URL`] || DEEPSEEK_BASE_URL
  const official = isDeepSeekBaseUrl(baseUrl)
  return {
    baseUrl,
    model: process.env[`${role}_MODEL`] || (official ? DEFAULT_DEEPSEEK_MODEL : ''),
    family: process.env[`${role}_FAMILY`] || (official ? 'deepseek' : ''),
    apiKey:
      process.env[`${role}_API_KEY`] || (official ? (process.env.DEEPSEEK_API_KEY ?? '') : ''),
  }
}
export const defaultSettings = (): Settings => ({
  worker: modelDefaults('WORKER'),
  reviewer: modelDefaults('REVIEWER'),
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
  private grilling = new Set<string>()
  private readonly settingsStore: SettingsStore
  constructor(root: string, settings = defaultSettings()) {
    this.store = new Store(root)
    this.settingsStore = new SettingsStore(this.store.root)
    this.settings = this.settingsStore.load(settings)
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
      sharedDeepSeekKey:
        !!this.settings.worker.apiKey &&
        this.settings.worker.apiKey === this.settings.reviewer.apiKey &&
        isDeepSeekBaseUrl(this.settings.worker.baseUrl) &&
        isDeepSeekBaseUrl(this.settings.reviewer.baseUrl),
    }
  }
  configured() {
    return [this.settings.worker, this.settings.reviewer].every(
      (c) =>
        c.baseUrl &&
        c.model &&
        c.family &&
        (c.apiKey || /^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(c.baseUrl)),
    )
  }
  updateSettings(patch: {
    worker: Settings['worker']
    reviewer: Settings['reviewer']
    reviewTimeoutMs: number
    gateTimeoutMs?: number
  }) {
    patch = structuredClone(patch)
    completionUrl(patch.worker.baseUrl)
    completionUrl(patch.reviewer.baseUrl)
    for (const role of ['worker', 'reviewer'] as const) {
      const old = this.settings[role],
        next = patch[role]
      // An empty password only retains the credential for the very same endpoint.
      if (
        !next.apiKey &&
        (old.baseUrl === next.baseUrl ||
          (isDeepSeekBaseUrl(old.baseUrl) && isDeepSeekBaseUrl(next.baseUrl)))
      )
        next.apiKey = old.apiKey
    }
    const settings = { ...this.settings, ...patch }
    this.settingsStore.save(settings)
    this.settings = settings
    return this.publicSettings()
  }
  create(prompt: string, mode: Mode, withGrill = false): RunState {
    if (mode === 'live' && !this.configured())
      throw new ConflictError('请先设置执行模型和独立审查模型')
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
      ...(withGrill ? { grill: emptyGrill() } : {}),
    }
    this.states.set(id, state)
    this.store.append(state, 'run.created', { prompt, mode, constraints: state.constraints })
    this.store.save(state)
    this.publish(state)
    return state
  }
  async advanceGrill(id: string, input: { round: number; answer?: string }) {
    if (this.grilling.has(id)) throw new ConflictError('正在整理本轮回答，请稍候。')
    const state = this.get(id)
    if (state.mode !== 'live') throw new ConflictError('开发测试记录不调用需求模型。')
    if (!this.configured()) throw new ConflictError('请先配置模型。')
    this.grilling.add(id)
    try {
      state.grill = await nextGrill(state, this.settings, input)
      this.store.append(state, 'grill.updated', {
        round: state.grill.round,
        status: state.grill.status,
      })
      this.store.save(state)
      this.publish(state)
      return state
    } finally {
      this.grilling.delete(id)
    }
  }
  async start(
    id: string,
    constraints: string[],
    options?: RuntimeOptions,
    confirmation?: GrillConfirmation,
  ) {
    const state = this.get(id)
    if (state.status !== 'ready') throw new ConflictError('任务已经开始，不能重复启动')
    if (this.grilling.has(id)) throw new ConflictError('请等待当前澄清完成。')
    if (state.grill) constraints = confirmGrill(state.grill, constraints, confirmation)
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
    if (state.grill) state.grill.status = 'confirmed'
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
      input.kind === 'requirement' &&
      /^(?:请)?(?:继续|继续实现|继续执行|继续任务|恢复执行|恢复任务)[。.!！\s]*$/u.test(
        input.text.trim(),
      )
    )
      throw new ConflictError('继续执行请使用“继续任务”，无需新增要求。')
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
  async resume(
    id: string,
    input: { requestId: string; revision: number },
    options?: RuntimeOptions,
  ) {
    const state = this.get(id)
    if (
      this.store
        .events(id)
        .some(
          (event) =>
            event.type === 'run.resume-requested' &&
            (event.data as { requestId?: string }).requestId === input.requestId,
        )
    )
      return state
    if (input.revision !== state.revision) throw new ConflictError('要求已更新，请重新确认后继续。')
    if (!['interrupted', 'stopped', 'error'].includes(state.status))
      throw new ConflictError('当前任务无需恢复。')
    if (this.continuing.has(id) || this.grilling.has(id))
      throw new ConflictError('任务正在切换状态，请稍候。')
    if (
      this.list().some((s) => s.id !== id && ['running', 'waiting', 'stopping'].includes(s.status))
    )
      throw new ConflictError('另一个任务正在执行，请先结束它再继续本任务。')
    if (state.mode === 'live' && !this.configured())
      throw new ConflictError('请先配置模型，再继续任务。')
    this.continuing.add(id)
    const previousStatus = state.status
    try {
      const disposing = this.runtimes.get(id)?.dispose()
      state.status = 'running'
      await disposing
      const runtime = new DecisionRuntime(
        state,
        this.store,
        structuredClone(this.settings),
        this.publish,
        { ...options, continuation: true },
      )
      this.runtimes.set(id, runtime)
      state.error = undefined
      runtime.commit('run.resume-requested', { ...input, previousStatus })
      await runtime.start()
      return state
    } finally {
      this.continuing.delete(id)
    }
  }
  runtime(id: string) {
    this.get(id)
    const runtime = this.runtimes.get(id)
    if (!runtime) throw new ConflictError('旧决策不能重新放行。请使用“继续任务”。')
    return runtime
  }
  async delete(id: string) {
    const state = this.get(id)
    if (
      ['running', 'waiting', 'stopping'].includes(state.status) ||
      this.grilling.has(id) ||
      this.continuing.has(id)
    )
      throw new ConflictError('请先停止活动任务，再删除数据。')
    await this.runtimes.get(id)?.dispose()
    this.store.delete(id)
    this.runtimes.delete(id)
    this.states.delete(id)
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
