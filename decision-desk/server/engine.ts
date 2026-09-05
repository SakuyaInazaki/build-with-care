import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { parse as parseJavaScript } from 'acorn'
import { parse as parseCss } from 'postcss'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  createUserMessage,
  ToolCallId,
  type GenerateOptions,
  type LlmAdapter,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, {
  defineTool,
  type PreToolDecision,
  type ToolExecution,
} from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type {
  AdditionInput,
  Decision,
  Gate,
  Intervention,
  Review,
  RunState,
  Settings,
  Step,
  VerdictInput,
} from '../shared/types.js'
import { Store } from './store.js'
import { hash, inspectHtml, Workspace } from './workspace.js'
import { CompatibleAdapter } from './models.js'
import { DemoAdapter } from './demo.js'
import { LocalAgentExecutor } from '../../src/stream.js'
import {
  activeUnit,
  cancelUnits,
  checkUnitScope,
  closeUnit,
  declareUnit,
  prohibitedTools,
  unitControls,
  unitPolicy,
} from './work-units.js'
import {
  createReviewer,
  demoReview,
  localConstraint,
  memoryConstraint,
  noLoginConstraint,
  ReviewFormatError,
  type Reviewer,
} from './reviewer.js'

const now = () => new Date().toISOString()
export class ConflictError extends Error {
  status = 409
}
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup()
      reject(signal.reason ?? new Error('操作已取消'))
    }
    const cleanup = () => signal.removeEventListener('abort', abort)
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (v) => {
        cleanup()
        resolve(v)
      },
      (e) => {
        cleanup()
        reject(e)
      },
    )
  })
}

export interface RuntimeOptions {
  currentSettings?: () => Settings
  reviewer?: Reviewer
  adapter?: (onRequest: (o: GenerateOptions) => void) => LlmAdapter
  continuation?: boolean
  reviewRecoveryStepId?: string
}
export class DecisionRuntime {
  readonly workspace: Workspace
  private ctx?: Context
  private agent?: Agent
  private reviewer: Reviewer
  private pending = new Map<string, (decision: PreToolDecision) => void>()
  private stopRequested = false
  private started = false
  private requestCount = 0
  private lastProgressAt = 0
  private reviewRetry?: { stepId: string; resolve: () => void }
  private retriedReviews = new Set<string>()
  private recoveryController?: AbortController
  private recoveryTask?: Promise<void>
  private failures = new Map<string, number>()
  private workerRequestModel?: string

  constructor(
    readonly state: RunState,
    private store: Store,
    private settings: Settings,
    private publish: (state: RunState) => void,
    private options: RuntimeOptions = {},
  ) {
    if (state.mode === 'live') state.workUnitProtocol ??= true
    this.workspace = new Workspace(path.join(store.directory(state.id), 'workspace'))
    this.reviewer = options.reviewer ?? createReviewer(settings)
  }
  commit(type: string, data: unknown) {
    this.store.append(this.state, type, data)
    this.store.save(this.state)
    this.publish(this.state)
  }
  private message(text: string, role: 'agent' | 'system' = 'system') {
    this.state.messages.push({ id: randomUUID(), role, text, at: now() })
    this.commit('message', { role, text })
  }
  private syncSettings() {
    if (!this.options.currentSettings) return
    // Snapshot at request boundaries so saving settings never changes an in-flight call.
    this.settings = structuredClone(this.options.currentSettings())
    if (!this.options.reviewer) this.reviewer = createReviewer(this.settings)
  }
  private onRequest = (options: GenerateOptions) => {
    if (this.stopRequested) throw new Error('任务已停止')
    this.syncSettings()
    this.workerRequestModel = this.settings.worker.model
    if (this.state.mode === 'live') this.state.workerLabel = this.workerRequestModel
    this.requestCount++
    const context = JSON.stringify(options.messages)
    for (const i of this.state.interventions) {
      if (i.progress === 'recorded' && context.includes(`DECISION_DESK_INTERVENTION:${i.id}`)) {
        i.progress = 'delivered'
        this.commit('intervention.delivered', { id: i.id, requestNumber: this.requestCount })
      }
    }
    this.state.modelProgress = { phase: 'connecting', startedAt: now(), characters: 0 }
    this.lastProgressAt = 0
    this.commit('model.request', {
      number: this.requestCount,
      revision: this.state.revision,
      mode: this.state.mode,
      model: this.settings.worker.model,
      reasoningEffort: this.settings.worker.reasoningEffort,
    })
  }

  async start() {
    if (this.started) throw new ConflictError('任务已经启动')
    this.started = true
    this.state.status = 'running'
    this.commit('run.started', { runtime: this.state.runtime })
    try {
      const ctx = new Context()
      this.ctx = ctx
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
      const adapter =
        this.options.adapter?.(this.onRequest) ??
        (this.state.mode === 'demo'
          ? new DemoAdapter(() => this.state, this.settings.demoDelayMs, this.onRequest)
          : new CompatibleAdapter(() => this.settings.worker, this.onRequest))
      ctx.llm.registerAdapter(['decision-desk'], adapter)
      ctx.systemPrompt.section({
        name: 'decision-desk:task',
        order: 0,
        text: () =>
          `你是一个在本地工作区实现小型网页应用的 Agent。使用 HTML/CSS/JavaScript，入口文件 index.html。只使用提供的工具，不调用外部系统。先完成必要的文件读取，再用 begin_unit 声明一个语义目标、设计决策和按顺序的工具计划（plan 中写入必须有 path）。声明通过后按计划执行；结束时调用 end_unit。取消未完成计划时 end_unit 的 cancelled=true。不要把一个整任务塞进一个单元；每次推进一个可检查的小目标。将实现代码直接放入写入工具参数，不要先完整草拟整份代码再重复生成。每次写入后用 verify_app 检查。工具被拒绝时，阅读理由后重新规划，不重复同一违规调用。不要把验证范围夸大为完整正确性。完成后说明改变与实际验证情况。\n当前有效人类约束（版本 ${this.state.revision}）：\n${this.state.constraints
            .filter((c) => c.active)
            .map((c) => `${c.id}: ${c.text}`)
            .join('\n')}`,
      })
      this.registerTools(ctx)
      ctx.tools.guard((exec) =>
        prohibitedTools.has(exec.name) ? '该工具被工作台明确禁用。' : undefined,
      )
      ctx.on('tools/pre-execute', (exec, next) => this.preExecute(exec, next))
      ctx.on('tools/result', (exec, result) => {
        const step = this.state.steps.find((s) => s.callId === exec.callId)
        if (!step) return
        if (['denied', 'cancelled'].includes(step.status)) {
          if (step.tool === 'begin_unit') cancelUnits(this.state)
          return
        }
        if (this.stopRequested || exec.signal.aborted) {
          step.status = 'cancelled'
          step.finishedAt = now()
          const decision = this.state.decisions.find((d) => d.id === step.decisionId)
          if (decision) decision.executionStatus = 'cancelled'
          this.state.files = this.workspace.list()
          this.commit('tool.cancelled', { stepId: step.id })
          return
        }
        step.status = result.isError ? 'failed' : 'done'
        step.finishedAt = now()
        step.result = result.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
        const unit = this.state.workUnits?.find((unit) => unit.id === step.unitId)
        if (unit) {
          if (step.tool === 'begin_unit' && result.isError) {
            unit.status = 'cancelled'
            unit.closedAt = now()
          } else if (!result.isError && !unitControls.has(step.tool)) {
            const planned = unit.plan[unit.nextCall]
            if (planned?.tool === step.tool && (!planned.path || planned.path === step.args.path))
              unit.nextCall++
          }
        }
        const decision = this.state.decisions.find((d) => d.id === step.decisionId)
        if (decision) decision.executionStatus = step.status
        if (
          !result.isError &&
          step.artifactChanged &&
          ['write_file', 'edit_file'].includes(step.tool)
        ) {
          for (const i of this.state.interventions) {
            if (
              ['delivered', 'acted'].includes(i.progress) &&
              ['correct', 'enforce', 'followup'].includes(i.action) &&
              i.additionKind !== 'idea'
            ) {
              i.progress = 'acted'
              if (!i.subsequentStepIds.includes(step.id)) i.subsequentStepIds.push(step.id)
            }
          }
        }
        const failureKey = `${step.tool}:${String(step.args.path ?? '')}`
        if (result.isError) {
          const count = (this.failures.get(failureKey) ?? 0) + 1
          this.failures.set(failureKey, count)
          if (count >= 3)
            this.requestStop('同一操作连续失败 3 次，已停止自动尝试。请查看证据后调整要求。', false)
        } else if (step.tool !== 'verify_app') this.failures.delete(failureKey)
        this.state.files = this.workspace.list()
        this.commit('tool.finished', { stepId: step.id, status: step.status })
      })
      ctx.on('session/event', (_session, event) => {
        this.store.recordRaw(this.state.id, event)
        if (event.type === 'assistant/chunk' && this.state.status === 'running') {
          const chunk = (event.data as any).chunk
          const progress = this.state.modelProgress
          if (
            progress &&
            ['reasoning-delta', 'text-delta', 'tool-call-delta'].includes(chunk.type)
          ) {
            progress.phase = chunk.type === 'reasoning-delta' ? 'thinking' : 'writing'
            progress.characters += (chunk.text ?? chunk.argumentsDelta ?? '').length
            progress.lastReceivedAt = now()
            if (Date.now() - this.lastProgressAt >= 500) {
              this.lastProgressAt = Date.now()
              this.publish(this.state)
            }
          }
        }
        if (event.type === 'assistant/message') {
          const data = event.data as any
          const progress = this.state.modelProgress
          this.state.modelProgress = undefined
          this.commit('model.response', {
            number: this.requestCount,
            model: this.workerRequestModel ?? this.settings.worker.model,
            usage: data.usage,
            elapsedMs: progress ? Date.now() - Date.parse(progress.startedAt) : undefined,
            responseSeq: event.seq,
            responseTime: event.time,
            interrupted: !!data.interrupted,
          })
          const content = data.message?.content ?? []
          const text = content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('\n')
          if (text) this.message(text, 'agent')
        }
        if (event.type === 'turn/end' && (event.data as any).reason?.kind === 'error')
          this.fail(new Error('执行模型未完成本轮，请检查连接配置与运行记录'))
      })
      ctx.on('agent/error', ({ error }) => this.fail(error))
      ctx.on('agent/status', ({ status }) => {
        if (
          status !== 'idle' ||
          !this.started ||
          ['error', 'interrupted'].includes(this.state.status)
        )
          return
        this.state.status = this.stopRequested ? 'stopped' : 'completed'
        if (activeUnit(this.state)) {
          cancelUnits(this.state)
          if (!this.stopRequested) {
            this.state.status = 'error'
            this.state.error =
              '执行模型结束时仍有未关闭的工作单元，请继续任务完成或明确取消剩余计划。'
          }
        }
        this.state.modelProgress = undefined
        this.state.reviewFailure = undefined
        this.commit('run.settled', { status: this.state.status })
      })
      const startAgent = (recoveryResult = '') => {
        this.agent = ctx.agentLoop.create(
          SessionId(this.state.id),
          {
            provider: 'decision-desk',
            model: this.state.mode === 'demo' ? 'scripted-demo' : this.settings.worker.model,
          },
          { cwd: this.workspace.root },
        )
        if (this.stopRequested) {
          this.state.status = 'stopped'
          this.commit('run.stopped', {})
          return
        }
        this.agent.followup(
          createUserMessage({
            content: [
              {
                type: 'text',
                text:
                  this.state.prompt +
                  recoveryResult +
                  (this.options.continuation || this.state.steps.length
                    ? '\n这是人明确要求的继续执行。沿用当前有效要求，先读取现有文件，保留已经完成的部分。已完成的历史动作不需要重演，已取消的旧调用不得直接放行。当前文件：' +
                      JSON.stringify(this.workspace.list())
                    : '') +
                  '\n' +
                  this.state.interventions
                    .filter(
                      (i) =>
                        i.progress === 'recorded' &&
                        ['followup', 'correct', 'enforce'].includes(i.action),
                    )
                    .map((i) =>
                      i.action === 'followup'
                        ? this.additionText(i)
                        : `DECISION_DESK_INTERVENTION:${i.id}\n人类纠正：${i.text}`,
                    )
                    .join('\n'),
              },
            ],
            source: { kind: 'user' },
          }),
        )
      }
      const recoveryStep = this.state.steps.find(
        (step) => step.id === this.options.reviewRecoveryStepId,
      )
      if (recoveryStep) {
        this.recoveryController = new AbortController()
        this.recoveryTask = ctx.tools
          .execute({
            callId: ToolCallId(recoveryStep.callId),
            name: recoveryStep.tool,
            arguments: structuredClone(recoveryStep.args),
            signal: this.recoveryController.signal,
          })
          .then((result) => {
            if (this.stopRequested) return
            const text = result.content
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
              .join('\n')
            startAgent(
              `\n上次暂停的 ${recoveryStep.tool} 已恢复处理，动作结果：${text}\n依据实际结果继续验证或修正，不要重复已完成写入。`,
            )
          })
          .catch((error) => this.fail(error))
      } else startAgent()
    } catch (error) {
      this.fail(error)
    }
  }

  private registerTools(ctx: Context) {
    const output = {
      schema: { type: 'json' as const },
      render: (_args: unknown, value: unknown) => [
        { type: 'text' as const, text: JSON.stringify(value) },
      ],
    }
    ctx.tools.register(
      defineTool({
        name: 'list_files',
        description: '列出本任务工作区中的文件，不读取其他项目。',
        parameters: {},
        output,
        async execute() {
          return thisRuntime.workspace.list()
        },
      }),
    )
    const thisRuntime = this
    ctx.tools.register(
      defineTool({
        name: 'begin_unit',
        description:
          '开始一个语义工作单元。先读取必要资料，再声明目标、设计决策与按执行顺序排列的工具/文件计划。写入必须在通过审查的单元内进行。',
        parameters: {
          goal: { type: 'string', required: true },
          decisions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                domain: { type: 'string', required: true },
                choice: { type: 'string', required: true },
                rationale: { type: 'string' },
                specifiedByHuman: { type: 'boolean' },
              },
            },
          },
          plan: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { tool: { type: 'string', required: true }, path: { type: 'string' } },
            },
          },
        },
        output,
        async execute(_args, exec) {
          const step = thisRuntime.state.steps.find((step) => step.callId === exec.callId)
          const unit = thisRuntime.state.workUnits?.find((unit) => unit.id === step?.unitId)
          if (!unit || unit.status !== 'declared')
            throw new Error('工作单元声明已失效，请重新声明。')
          unit.status = 'active'
          thisRuntime.commit('unit.started', { unitId: unit.id, goal: unit.goal })
          return { unitId: unit.id, goal: unit.goal, plan: unit.plan }
        },
      }),
    )
    ctx.tools.register(
      defineTool({
        name: 'end_unit',
        description:
          '结束当前工作单元并总结实际结果。Host 会自动检查本单元写入文件，检查失败不能完成单元；计划未完成或需要重新规划时明确 cancelled=true。静态检查不等于完整功能验收。',
        parameters: { summary: { type: 'string', required: true }, cancelled: { type: 'boolean' } },
        output,
        async execute(args) {
          if (!args.cancelled) {
            const active = activeUnit(thisRuntime.state)
            if (!active || active.nextCall !== active.plan.length)
              throw new Error('单元计划尚未执行完，不能结束。')
            const removedPaths = thisRuntime.state.steps
              .filter(
                (step) =>
                  step.unitId === active.id &&
                  step.tool === 'run_command' &&
                  ['done', 'failed', 'cancelled'].includes(step.status),
              )
              .flatMap((step) => step.removedArtifactPaths ?? [])
            if (removedPaths.length)
              throw new Error(
                `受控命令删除了产物 ${[...new Set(removedPaths)].join('、')}，当前检查器无法为删除结果生成文件哈希证据。请取消本单元并重新规划。`,
              )
            const explicitChecks = new Map<string, Step>()
            for (const step of thisRuntime.state.steps)
              if (step.unitId === active.id && step.tool === 'verify_app' && step.status === 'done')
                explicitChecks.set(String(step.args.path), step)
            for (const [file, step] of explicitChecks)
              if (!thisRuntime.hasCurrentPassingVerification(file, step.id))
                throw new Error(
                  `本单元对 ${file} 的显式检查未通过当前要求与文件哈希校验，不能将单元标为完成。请修复后重新检查，或取消本单元并重新规划。`,
                )
            const paths = thisRuntime.state.steps
              .filter((step) => step.unitId === active.id)
              .flatMap((step) =>
                ['write_file', 'edit_file'].includes(step.tool) && step.status === 'done'
                  ? [String(step.args.path)]
                  : step.tool === 'run_command' &&
                      ['done', 'failed', 'cancelled'].includes(step.status)
                    ? (step.artifactPaths ?? [])
                    : [],
              )
            const result = thisRuntime.verifyArtifacts(
              paths.filter((file) => !thisRuntime.hasCurrentPassingVerification(file)),
              active.id,
            )
            if (!result.passed)
              throw new Error(
                '单元检查未通过，请查看检查结果，取消本单元并声明修复计划后继续；不能将其标为完成。',
              )
          }
          const unit = closeUnit(thisRuntime.state, args.summary, args.cancelled ?? false)
          thisRuntime.commit('unit.closed', {
            unitId: unit.id,
            status: unit.status,
            summary: unit.summary,
          })
          return { unitId: unit.id, status: unit.status }
        },
      }),
    )
    ctx.tools.register(
      defineTool({
        name: 'read_file',
        description: '读取工作区内的文本文件。',
        parameters: { path: { type: 'string', required: true } },
        output,
        async execute({ path }) {
          return { path, content: thisRuntime.workspace.read(path) }
        },
      }),
    )
    ctx.tools.register(
      defineTool({
        name: 'write_file',
        description:
          '写入完整文本文件。调用前会核对人类约束。intent描述这次改动的目的，不代表已经获准。',
        parameters: {
          path: { type: 'string', required: true },
          content: { type: 'string', required: true },
          intent: { type: 'string', required: true },
        },
        output,
        async execute(args, exec) {
          return thisRuntime.write(args.path, args.content, String(exec.callId))
        },
      }),
    )
    ctx.tools.register(
      defineTool({
        name: 'edit_file',
        description: '对文件中的唯一一处精确文本作替换。先读取文件。',
        parameters: {
          path: { type: 'string', required: true },
          oldText: { type: 'string', required: true },
          newText: { type: 'string', required: true },
          intent: { type: 'string', required: true },
        },
        output,
        async execute(args, exec) {
          return thisRuntime.write(
            args.path,
            thisRuntime.workspace.previewEdit(args.path, args.oldText, args.newText),
            String(exec.callId),
          )
        },
      }),
    )
    ctx.tools.register(
      defineTool({
        name: 'verify_app',
        description:
          '运行固定静态检查：HTML 结构、内联 JS 语法及可识别的免登录、无外部资源、内存保存约束；独立 JS/CSS/JSON 文件检查语法。其他文件类型尚无自动规则。不是完整运行时证明。',
        parameters: { path: { type: 'string', required: true } },
        output,
        async execute({ path }, exec) {
          return thisRuntime.verify(path, String(exec.callId))
        },
      }),
    )
    ctx.tools.register(
      defineTool({
        name: 'run_command',
        description:
          '在当前任务工作区运行受控命令：node --version、npm test、npm run typecheck、npm run build。命令始终接受审查，结果只代表该命令实际执行结果。',
        parameters: {
          command: { type: 'string', required: true },
          intent: { type: 'string', required: true },
        },
        output,
        async execute(args, exec) {
          const step = thisRuntime.state.steps.find((step) => step.callId === exec.callId)
          if (thisRuntime.stopRequested || !step || step.revision !== thisRuntime.state.revision)
            throw new Error('任务已停止或要求已更新，请重新提出调用。')
          const filesBefore = new Map(
            thisRuntime.workspace.list().map((file) => [file.path, file.hash]),
          )
          const result = await new LocalAgentExecutor(thisRuntime.workspace.root).execute({
            sessionId: thisRuntime.state.id,
            branchId: 'main',
            agentId: 'worker',
            turn: 0,
            step: thisRuntime.state.steps.length,
            cardId: step.id,
            executionId: String(exec.callId),
            signal: exec.signal,
            action: {
              tool: 'run_command',
              kind: 'command',
              description: args.intent,
              args: { command: args.command, external: true },
            },
          })
          thisRuntime.state.files = thisRuntime.workspace.list()
          const filesAfter = new Map(thisRuntime.state.files.map((file) => [file.path, file.hash]))
          step.artifactPaths = thisRuntime.state.files
            .filter((file) => filesBefore.get(file.path) !== file.hash)
            .map((file) => file.path)
          step.removedArtifactPaths = [...filesBefore.keys()].filter(
            (file) => !filesAfter.has(file),
          )
          for (const check of thisRuntime.state.verifications)
            if (
              !thisRuntime.state.files.some(
                (file) => file.path === check.path && file.hash === check.artifactHash,
              )
            )
              check.stale = true
          if (thisRuntime.stopRequested || exec.signal.aborted)
            throw new Error('任务已停止，命令结果不再作为成功证据。')
          if (!result.ok) throw new Error(result.error ?? '命令失败')
          return {
            command: args.command,
            output: String(result.output ?? ''),
            externalSideEffect: true,
          }
        },
      }),
    )
  }

  private write(file: string, content: string, callId: string) {
    const step = this.state.steps.find((s) => s.callId === callId)
    // This last-mile check and the synchronous write run in one JS turn.
    if (this.stopRequested || !step || step.revision !== this.state.revision)
      throw new Error('人的要求已更新或任务已停止，此旧调用不得执行。请重新规划。')
    const previousHash = this.state.files.find((f) => f.path === file)?.hash
    const artifact = this.workspace.write(file, content)
    step.artifactChanged = previousHash !== artifact.hash
    for (const v of this.state.verifications)
      if (v.path === file && v.artifactHash !== artifact.hash) v.stale = true
    for (const i of this.state.interventions)
      if (
        i.progress === 'verified' &&
        i.subsequentStepIds.some(
          (id) => this.state.steps.find((s) => s.id === id)?.args.path === file,
        )
      )
        i.progress = 'acted'
    this.state.files = this.workspace.list()
    this.commit('artifact.written', artifact)
    return artifact
  }

  private verify(file: string, callId: string) {
    const content = this.workspace.read(file),
      checks = inspectHtml(content),
      active = this.state.constraints.filter((c) => c.active)
    const step = this.state.steps.find((s) => s.callId === callId)!
    let results = [
      {
        name: 'HTML 基本结构',
        passed: checks.structure,
        detail: '检查 html、title 和 body 元素。',
      },
      {
        name: '内联 JavaScript 语法',
        passed: checks.validJavaScript,
        detail: '使用解析器检查内联脚本；不代表全部交互已验证。',
      },
      ...(memoryConstraint(active)
        ? [
            {
              name: '无浏览器持久化引用',
              passed: !checks.persistence,
              detail:
                '静态检查内联脚本中的 localStorage、sessionStorage 和 indexedDB 引用；不涵盖动态别名或外部脚本。',
            },
          ]
        : []),
      ...(localConstraint(active)
        ? [
            {
              name: '无外部页面资源',
              passed: !checks.externalResources,
              detail: '检查 HTML src 和 link href；不涵盖脚本运行时网络请求。',
            },
          ]
        : []),
      ...(noLoginConstraint(active)
        ? [
            {
              name: '无密码输入框',
              passed: !checks.visibleLogin,
              detail: '检查 HTML 中的 password 输入；不证明不存在其他登录流程。',
            },
          ]
        : []),
    ]
    if (!file.endsWith('.html')) {
      const kind = path.extname(file)
      const name =
        kind === '.js'
          ? 'JavaScript 语法'
          : kind === '.css'
            ? 'CSS 语法'
            : kind === '.json'
              ? 'JSON 格式'
              : ['.md', '.txt'].includes(kind)
                ? '文本可读取与哈希绑定'
                : '文件自动检查覆盖'
      try {
        if (kind === '.js')
          parseJavaScript(content, { ecmaVersion: 'latest', sourceType: 'module' })
        else if (kind === '.css') parseCss(content, { from: file })
        else if (kind === '.json') JSON.parse(content)
        else if (['.md', '.txt'].includes(kind)) {
          if (content.includes('\uFFFD'))
            throw new Error('文本包含无法解码的替代字符，请检查文件编码。')
        } else throw new Error('该文件类型尚无自动验证规则，需要补充针对性验证。')
        results = [
          {
            name,
            passed: true,
            detail: ['.md', '.txt'].includes(kind)
              ? `读取 ${file} 并绑定当前文件哈希；不验证文本语义或内容正确性。`
              : `解析 ${file}，仅证明格式或语法有效。`,
          },
        ]
      } catch (error) {
        results = [
          { name, passed: false, detail: error instanceof Error ? error.message : '解析失败' },
        ]
      }
    }
    for (const result of results)
      this.state.verifications.push({
        ...result,
        id: randomUUID(),
        stepId: step.id,
        path: file,
        artifactHash: hash(content),
        stale: false,
        createdAt: now(),
        revision: this.state.revision,
      })
    for (const i of this.state.interventions) {
      if (
        file.endsWith('.html') &&
        i.progress === 'acted' &&
        /内存|刷新|持久化/.test(i.text) &&
        memoryConstraint(active) &&
        !checks.persistence &&
        checks.validJavaScript &&
        i.subsequentStepIds.some(
          (id) => this.state.steps.find((s) => s.id === id)?.args.path === file,
        )
      )
        i.progress = 'verified'
    }
    const failureKey = `verify_app:${file}`
    if (results.some((r) => !r.passed)) {
      const count = (this.failures.get(failureKey) ?? 0) + 1
      this.failures.set(failureKey, count)
      if (count >= 3) this.requestStop('对应检查连续失败 3 次，已停止自动尝试。', false)
    } else this.failures.delete(failureKey)
    this.commit('verification.completed', { stepId: step.id, path: file, results })
    return {
      path: file,
      passed: results.every((r) => r.passed),
      results,
      scope: '仅上述静态检查，完整交互需在预览中验收',
    }
  }

  verifyArtifacts(paths: string[], unitId?: string) {
    const results: { path: string; passed: boolean }[] = []
    for (const file of [...new Set(paths)]) {
      if (unitId && this.stopRequested) throw new Error('任务已停止')
      const callId = randomUUID()
      const step: Step = {
        id: randomUUID(),
        callId,
        tool: 'verify_app',
        args: { path: file },
        unitId,
        revision: this.state.revision,
        createdAt: now(),
        status: 'executing',
      }
      this.state.steps.push(step)
      this.state.workUnits?.find((unit) => unit.id === unitId)?.stepIds.push(step.id)
      this.commit('tool.proposed', { step, origin: 'host-verification' })
      try {
        const result = this.verify(file, callId)
        step.result = JSON.stringify(result)
        step.status = 'done'
        results.push({ path: file, passed: result.passed })
      } catch (error) {
        step.status = 'failed'
        step.result = error instanceof Error ? error.message : '检查失败'
        results.push({ path: file, passed: false })
      }
      step.finishedAt = now()
      this.state.files = this.workspace.list()
      this.commit('tool.finished', { stepId: step.id, status: step.status })
    }
    return { passed: results.every((result) => result.passed), results }
  }

  private hasCurrentPassingVerification(file: string, stepId?: string) {
    const artifact = this.state.files.find((entry) => entry.path === file)
    if (!artifact) return false
    const current = this.state.verifications.filter(
      (check) =>
        check.path === file &&
        check.artifactHash === artifact.hash &&
        check.revision === this.state.revision &&
        !check.stale &&
        (!stepId || check.stepId === stepId),
    )
    if (!current.length) return false
    const latestStepId = stepId ?? current.at(-1)!.stepId
    const latest = current.filter((check) => check.stepId === latestStepId)
    return latest.length > 0 && latest.every((check) => check.passed)
  }

  private async preExecute(
    exec: ToolExecution,
    next: () => Promise<PreToolDecision>,
  ): Promise<PreToolDecision> {
    if (this.stopRequested || exec.signal.aborted) return { kind: 'deny', reason: '任务已停止' }
    const recovering = this.state.steps.find(
      (step) => step.id === this.options.reviewRecoveryStepId && step.callId === exec.callId,
    )
    const step: Step = recovering ?? {
      id: randomUUID(),
      callId: exec.callId,
      tool: exec.name,
      ...(exec.name === 'run_command' ? { externalSideEffect: true } : {}),
      args: structuredClone(exec.arguments) as Record<string, unknown>,
      revision: this.state.revision,
      createdAt: now(),
      status: 'reviewing',
    }
    if (recovering) {
      this.options.reviewRecoveryStepId = undefined
      step.status = 'reviewing'
      step.finishedAt = undefined
      step.result = undefined
      this.commit('review.recovered', { stepId: step.id })
    } else {
      this.state.steps.push(step)
      this.commit('tool.proposed', { step })
    }
    try {
      const unit =
        step.tool === 'begin_unit'
          ? declareUnit(
              this.state,
              step.args,
              this.ctx!.tools.schemas().map((tool) => tool.name),
            )
          : step.tool === 'end_unit'
            ? activeUnit(this.state)
            : checkUnitScope(this.state, step.tool, step.args)
      if (unit) {
        step.unitId = unit.id
        unit.stepIds.push(step.id)
        this.commit(step.tool === 'begin_unit' ? 'unit.declared' : 'unit.call-bound', {
          unitId: unit.id,
          stepId: step.id,
        })
      }
      if (step.tool === 'end_unit') {
        step.status = 'executing'
        return next()
      }
    } catch (error) {
      return { kind: 'deny', reason: error instanceof Error ? error.message : '工作单元校验失败' }
    }
    let review: Review
    for (;;) {
      this.syncSettings()
      if (this.state.mode === 'live') this.state.reviewerLabel = this.settings.reviewer.model
      const revision = this.state.revision
      step.revision = revision
      // Local tool errors go back to the worker through dsh's tool-result path.
      // Retrying the reviewer cannot repair stale or ambiguous edit arguments.
      let reviewArgs = step.args
      if (step.tool === 'edit_file') {
        try {
          reviewArgs = {
            ...step.args,
            content: this.workspace.previewEdit(
              String(step.args.path),
              String(step.args.oldText ?? ''),
              String(step.args.newText ?? ''),
            ),
          }
        } catch (error) {
          return {
            kind: 'deny',
            reason: error instanceof Error ? error.message : '无法准备文件修改',
          }
        }
      }
      this.state.modelProgress = { phase: 'reviewing', startedAt: now(), characters: 0 }
      this.commit('review.started', {
        stepId: step.id,
        revision,
        model: this.settings.reviewer.model,
      })
      const slowTimer = setTimeout(() => {
        if (this.state.modelProgress?.phase !== 'reviewing') return
        this.state.modelProgress.phase = 'review-slow'
        this.commit('review.slow', { stepId: step.id, elapsedMs: this.settings.reviewTimeoutMs })
      }, this.settings.reviewTimeoutMs)
      slowTimer.unref()
      try {
        review = await abortable(
          this.reviewer(this.state, exec.name, reviewArgs, exec.signal),
          exec.signal,
        )
        const floor = unitPolicy(
          this.state,
          step.tool,
          reviewArgs,
          this.state.workUnits?.find((unit) => unit.id === step.unitId),
        )
        const contentRule = demoReview(this.state, step.tool, reviewArgs)
        if (floor && review.classification !== 'conflict') review = floor
        else if (
          this.state.mode === 'live' &&
          contentRule.classification === 'conflict' &&
          review.classification !== 'conflict'
        )
          review = { ...contentRule, source: 'system' }
      } catch (error) {
        clearTimeout(slowTimer)
        this.state.modelProgress = undefined
        if (this.stopRequested || exec.signal.aborted) {
          step.status = 'cancelled'
          this.commit('tool.cancelled', { stepId: step.id })
          return { kind: 'deny', reason: '审查已取消' }
        }
        const reason = error instanceof Error ? error.message : '审查未完成'
        const message = /timeout|超时|响应超过/i.test(reason)
          ? '审查服务超时，本次动作未执行。'
          : `审查未完成，本次动作未执行：${reason}`
        this.state.reviewFailure = { stepId: step.id, message }
        const retry = new Promise<void>((resolve) => {
          this.reviewRetry = { stepId: step.id, resolve }
        })
        this.commit('review.failed', {
          stepId: step.id,
          message,
          ...(error instanceof ReviewFormatError ? { reviewerResponse: error.response } : {}),
        })
        try {
          await abortable(retry, exec.signal)
        } catch {
          step.status = 'cancelled'
          this.commit('tool.cancelled', { stepId: step.id })
          return { kind: 'deny', reason: '审查已取消' }
        } finally {
          this.reviewRetry = undefined
          this.state.reviewFailure = undefined
        }
        continue
      } finally {
        clearTimeout(slowTimer)
        this.state.modelProgress = undefined
      }
      if (this.stopRequested || exec.signal.aborted) {
        step.status = 'cancelled'
        this.commit('tool.cancelled', { stepId: step.id })
        return { kind: 'deny', reason: '任务已停止' }
      }
      if (revision !== this.state.revision) {
        this.commit('review.invalidated', {
          stepId: step.id,
          oldRevision: revision,
          currentRevision: this.state.revision,
        })
        continue
      }
      break
    }
    this.commit('review.completed', { stepId: step.id, review })
    step.review = review
    if (review.classification !== 'execution') {
      const key = `${review.topic}:${String(step.args.path ?? '')}`
      let decision = this.state.decisions.find(
        (d) =>
          d.unitId === step.unitId &&
          (step.unitId !== undefined ||
            `${d.review.topic}:${String(this.state.steps.find((s) => s.id === d.stepIds[0])?.args.path ?? '')}` ===
              key) &&
          d.revision === step.revision &&
          d.review.classification === review.classification,
      )
      if (!decision) {
        decision = {
          id: randomUUID(),
          unitId: step.unitId,
          stepIds: [],
          review,
          revision: step.revision,
          createdAt: now(),
          humanStatus: 'unreviewed',
          executionStatus: step.status,
        }
        this.state.decisions.push(decision)
      }
      decision.stepIds.push(step.id)
      decision.review = review
      step.decisionId = decision.id
      if (['conflict', 'uncertain'].includes(review.classification))
        return this.waitForHuman(exec, step, decision)
      decision.executionStatus = 'executing'
    }
    step.status = 'executing'
    this.commit('tool.allowed', { stepId: step.id, revision: step.revision, automatic: true })
    return next()
  }

  private waitForHuman(
    exec: ToolExecution,
    step: Step,
    decision: Decision,
  ): Promise<PreToolDecision> {
    const gate: Gate = {
      id: randomUUID(),
      stepId: step.id,
      decisionId: decision.id,
      revision: step.revision,
      argsHash: hash(JSON.stringify(step.args)),
      status: 'pending',
      expiresAt: new Date(Date.now() + this.settings.gateTimeoutMs).toISOString(),
    }
    this.state.gates.push(gate)
    decision.gateId = gate.id
    decision.executionStatus = 'waiting'
    step.status = 'waiting'
    this.state.status = 'waiting'
    this.commit('gate.pending', { gate })
    return new Promise((resolve) => {
      let settled = false
      const settle = (verdict: PreToolDecision) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        exec.signal.removeEventListener('abort', abort)
        this.pending.delete(gate.id)
        resolve(verdict)
      }
      const abort = () => {
        if (gate.status === 'pending') {
          gate.status = 'cancelled'
          step.status = 'cancelled'
          decision.executionStatus = 'cancelled'
          this.commit('gate.cancelled', { gateId: gate.id })
        }
        settle({ kind: 'deny', reason: '本次操作已取消' })
      }
      const timer = setTimeout(() => {
        if (gate.status !== 'pending') return
        gate.status = 'expired'
        step.status = 'denied'
        decision.executionStatus = 'denied'
        this.commit('gate.expired', { gateId: gate.id })
        settle({ kind: 'deny', reason: '人工处理已过期，未执行此动作' })
        this.requestStop('人工处理等待超时，任务已停止。', false)
      }, this.settings.gateTimeoutMs)
      timer.unref()
      this.pending.set(gate.id, settle)
      exec.signal.addEventListener('abort', abort, { once: true })
      if (exec.signal.aborted || this.stopRequested) abort()
    })
  }

  private additionText(intervention: Intervention) {
    return `DECISION_DESK_INTERVENTION:${intervention.id}\n${intervention.additionKind === 'idea' ? '人补充的参考想法（不改变硬约束）：请先回应可行性，不要据此自行修改产物，等待人明确要求实施。' : '人追加的有效要求：请据此继续或修补当前产物，保留其他已完成部分，并运行对应检查。'}\n${intervention.text}`
  }

  addInput(input: AdditionInput) {
    const prior = this.state.interventions.find((i) => i.requestId === input.requestId)
    if (prior) return prior
    if (input.revision !== this.state.revision)
      throw new ConflictError('要求已更新，请核对最新内容后重新提交')
    if (this.stopRequested || this.state.status === 'stopping')
      throw new ConflictError('正在停止，请等任务结束后再追加')
    const text = input.text.trim()
    if (!text) throw new ConflictError('请写下要补充的内容')
    if (
      input.replaceConstraintId &&
      (input.kind !== 'requirement' ||
        !this.state.constraints.some((c) => c.id === input.replaceConstraintId && c.active))
    )
      throw new ConflictError('要替换的要求已失效，请重新选择')
    const fromRevision = this.state.revision
    if (input.kind === 'requirement') {
      this.state.revision++
      if (input.replaceConstraintId)
        this.state.constraints.find((c) => c.id === input.replaceConstraintId)!.active = false
      this.state.constraints.push({
        id: randomUUID(),
        text,
        source: '人追加的新要求',
        revision: this.state.revision,
        active: true,
      })
    }
    const intervention: Intervention = {
      id: randomUUID(),
      requestId: input.requestId,
      action: 'followup',
      additionKind: input.kind,
      text,
      fromRevision,
      toRevision: this.state.revision,
      createdAt: now(),
      progress: 'recorded',
      subsequentStepIds: [],
    }
    this.state.interventions.push(intervention)
    this.commit('human.intervention', { intervention, constraints: this.state.constraints })
    const message = createUserMessage({
      content: [{ type: 'text', text: this.additionText(intervention) }],
      source: { kind: 'plugin', plugin: 'decision-desk' },
    })
    if (this.agent?.status === 'idle') {
      this.requestCount = 0
      this.state.status = 'running'
      this.agent.steer(message)
    } else this.agent?.inject(message)
    if (input.kind === 'requirement') {
      for (const gate of this.state.gates.filter(
        (g) => g.status === 'pending' && g.revision !== this.state.revision,
      )) {
        gate.status = 'denied'
        const step = this.state.steps.find((s) => s.id === gate.stepId)!
        step.status = 'denied'
        step.finishedAt = now()
        this.state.decisions.find((d) => d.id === gate.decisionId)!.executionStatus = 'denied'
        this.commit('gate.invalidated', { gateId: gate.id, interventionId: intervention.id })
        this.pending.get(gate.id)?.({
          kind: 'deny',
          reason: `人补充了新要求：${text}。请按有效约束版本 ${this.state.revision} 重新规划。`,
        })
      }
      if (this.state.status === 'waiting') this.state.status = 'running'
    }
    this.commit('run.input-added', { interventionId: intervention.id })
    return intervention
  }

  verdict(input: VerdictInput) {
    const prior = this.state.interventions.find((i) => i.requestId === input.requestId)
    if (prior) return prior
    if (input.revision !== this.state.revision)
      throw new ConflictError('要求已更新，请刷新卡片后重新操作')
    if (
      this.stopRequested ||
      ['stopped', 'stopping', 'error', 'interrupted'].includes(this.state.status)
    )
      throw new ConflictError('任务已停止，不能放行旧调用')
    const decision = this.state.decisions.find((d) => d.id === input.decisionId)
    if (!decision) throw new ConflictError('该决策不存在')
    const gate = input.gateId
      ? this.state.gates.find((g) => g.id === input.gateId && g.decisionId === decision.id)
      : undefined
    if (input.gateId && (!gate || gate.status !== 'pending' || !this.pending.has(gate.id)))
      throw new ConflictError('这次工具调用已结束，请查看最新记录')
    if (
      gate &&
      (gate.revision !== this.state.revision ||
        gate.argsHash !==
          hash(JSON.stringify(this.state.steps.find((s) => s.id === gate.stepId)?.args)))
    )
      throw new ConflictError('这次调用的内容或约束已改变，不能使用旧卡片放行')
    if (['allow-once', 'enforce'].includes(input.action) && !gate)
      throw new ConflictError('该动作需要一个仍在等待的调用')
    if (input.action === 'acknowledge' && gate)
      throw new ConflictError('冲突必须明确纠正或仅本次允许')
    if (input.action === 'correct' && !input.text?.trim())
      throw new ConflictError('请写下希望怎样修改')
    const fromRevision = this.state.revision
    const text =
      input.action === 'enforce'
        ? `请按原要求改正：${
            decision.review.constraintIds
              .map((id) => this.state.constraints.find((c) => c.id === id)?.text)
              .filter(Boolean)
              .join('；') || decision.review.summary
          }`
        : input.text?.trim() ||
          (input.action === 'allow-once'
            ? '仅允许这一次具体调用，其他约束继续有效。'
            : '认可这项选择。')
    if (input.action === 'correct') {
      if (
        input.replaceConstraintId &&
        !this.state.constraints.some((c) => c.id === input.replaceConstraintId && c.active)
      )
        throw new ConflictError('要替换的约束已经失效')
      this.state.revision++
      if (input.replaceConstraintId)
        this.state.constraints.find((c) => c.id === input.replaceConstraintId)!.active = false
      this.state.constraints.push({
        id: randomUUID(),
        text,
        source: '人的本次纠正',
        revision: this.state.revision,
        active: true,
      })
    }
    const intervention: Intervention = {
      id: randomUUID(),
      requestId: input.requestId,
      decisionId: decision.id,
      ...(gate ? { stepId: gate.stepId } : {}),
      action: input.action,
      text,
      fromRevision,
      toRevision: this.state.revision,
      createdAt: now(),
      progress: 'recorded',
      subsequentStepIds: [],
    }
    this.state.interventions.push(intervention)
    decision.humanStatus =
      input.action === 'acknowledge'
        ? 'acknowledged'
        : input.action === 'allow-once'
          ? 'allowed-once'
          : 'corrected'
    this.commit('human.intervention', { intervention, constraints: this.state.constraints })
    if (input.action === 'acknowledge') return intervention
    if (input.action === 'correct' || input.action === 'enforce') {
      const message = createUserMessage({
        content: [
          {
            type: 'text',
            text: `DECISION_DESK_INTERVENTION:${intervention.id}\n人类纠正（有效约束版本 ${this.state.revision}）：${text}\n重新检查当前产物，必要时追加修补并运行对应检查。保留其他已完成部分。`,
          },
        ],
        source: { kind: 'plugin', plugin: 'decision-desk' },
      })
      if (this.agent?.status === 'idle') {
        this.state.status = 'running'
        this.agent.steer(message)
      } else this.agent?.inject(message)
    }
    for (const pendingGate of this.state.gates.filter((g) => g.status === 'pending')) {
      if (pendingGate.id !== gate?.id && pendingGate.revision === this.state.revision) continue
      const pendingStep = this.state.steps.find((s) => s.id === pendingGate.stepId)!
      const pendingDecision = this.state.decisions.find((d) => d.id === pendingGate.decisionId)!
      const allowed = pendingGate.id === gate?.id && input.action === 'allow-once'
      pendingGate.status = allowed ? 'allowed' : 'denied'
      pendingStep.status = allowed ? 'executing' : 'denied'
      pendingStep.finishedAt = allowed ? undefined : now()
      pendingDecision.executionStatus = pendingStep.status
      this.commit('gate.resolved', {
        gateId: pendingGate.id,
        status: pendingGate.status,
        interventionId: intervention.id,
      })
      this.pending.get(pendingGate.id)?.(
        allowed
          ? { kind: 'allow' }
          : {
              kind: 'deny',
              reason: `${text}。当前有效约束版本 ${this.state.revision}，请重新提出符合要求的调用。`,
            },
      )
    }
    if (this.state.status === 'waiting') this.state.status = 'running'
    this.commit('run.continuing', { interventionId: intervention.id })
    return intervention
  }

  retryReview(input: { requestId: string; revision: number; stepId: string }, settings: Settings) {
    if (this.retriedReviews.has(input.requestId)) return this.state
    if (input.revision !== this.state.revision)
      throw new ConflictError('要求已更新，请重新确认后重试。')
    if (this.stopRequested || !this.reviewRetry || this.reviewRetry.stepId !== input.stepId)
      throw new ConflictError('当前没有可重试的审查。')
    this.settings.reviewer = structuredClone(settings.reviewer)
    this.settings.reviewTimeoutMs = settings.reviewTimeoutMs
    if (!this.options.reviewer) this.reviewer = createReviewer(this.settings)
    this.state.reviewerLabel =
      this.state.mode === 'live' ? settings.reviewer.model : this.state.reviewerLabel
    const retry = this.reviewRetry
    this.reviewRetry = undefined
    this.state.reviewFailure = undefined
    this.retriedReviews.add(input.requestId)
    this.commit('review.retry-requested', input)
    retry.resolve()
    return this.state
  }

  requestStop(
    reason = '你停止了这次任务。已开始的操作以实际结果为准。',
    human = true,
    requestId: string = randomUUID(),
  ) {
    if (this.state.interventions.some((i) => i.requestId === requestId)) return
    if (['stopped', 'completed', 'error', 'interrupted'].includes(this.state.status)) {
      if (human) throw new ConflictError('任务已经结束，无需再次停止。')
      return
    }
    if (this.stopRequested) return
    this.stopRequested = true
    cancelUnits(this.state)
    this.state.modelProgress = undefined
    this.state.reviewFailure = undefined
    this.state.status = 'stopping'
    if (human)
      this.state.interventions.push({
        id: randomUUID(),
        requestId,
        action: 'stop',
        text: reason,
        fromRevision: this.state.revision,
        toRevision: this.state.revision,
        createdAt: now(),
        progress: 'recorded',
        subsequentStepIds: [],
      })
    this.commit('run.stop-requested', { reason, human })
    for (const gate of this.state.gates.filter((g) => g.status === 'pending')) {
      gate.status = 'cancelled'
      const step = this.state.steps.find((s) => s.id === gate.stepId)!
      step.status = 'cancelled'
      const decision = this.state.decisions.find((d) => d.id === gate.decisionId)!
      decision.executionStatus = 'cancelled'
      this.commit('gate.cancelled', { gateId: gate.id })
      this.pending.get(gate.id)?.({ kind: 'deny', reason })
    }
    this.recoveryController?.abort(new Error('任务已停止'))
    this.agent?.cancel({ kind: 'user' })
    if (!this.agent || this.agent.status === 'idle') {
      this.state.status = 'stopped'
      this.commit('run.stopped', { reason })
    }
  }
  fail(error: unknown) {
    if (this.stopRequested) return
    this.stopRequested = true
    cancelUnits(this.state)
    this.state.modelProgress = undefined
    this.state.reviewFailure = undefined
    this.state.status = 'error'
    this.state.error = error instanceof Error ? error.message : '运行发生错误'
    for (const gate of this.state.gates.filter((g) => g.status === 'pending')) {
      gate.status = 'cancelled'
      this.pending.get(gate.id)?.({ kind: 'deny', reason: '运行发生错误' })
    }
    for (const step of this.state.steps)
      if (['reviewing', 'waiting', 'executing'].includes(step.status)) step.status = 'cancelled'
    for (const decision of this.state.decisions)
      if (['reviewing', 'waiting', 'executing'].includes(decision.executionStatus))
        decision.executionStatus = 'cancelled'
    this.commit('run.error', { message: this.state.error })
    this.recoveryController?.abort(new Error('任务已停止'))
    this.agent?.cancel({ kind: 'user' })
  }
  async dispose() {
    if (!this.stopRequested && ['running', 'waiting'].includes(this.state.status))
      this.requestStop('服务关闭', false)
    await this.recoveryTask
    await this.agent?.whenIdle()
    await this.ctx?.fiber.dispose()
  }
}
