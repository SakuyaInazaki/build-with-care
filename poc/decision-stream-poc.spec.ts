import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, type PreToolDecision } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

/**
 * 决策流（Decision Stream）POC：验证黑客松方案的四个核心口子在 dsh 引擎层可行。
 * 场景：spec baseline = 「存储必须用 Postgres；界面文案用中文」。
 * 红卡 = 与 spec 冲突（sqlite）→ 弹卡挂起等人审；蓝卡 = spec 未指定 → 静默记录放行。
 */

interface Card {
  kind: 'red' | 'blue'
  tool: string
  args: unknown
}

async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

function events(agent: Agent): readonly SessionEvent[] {
  return agent.session.snapshotEvents()
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function requestText(request: { messages: readonly unknown[] }): string {
  return JSON.stringify(request.messages)
}

describe('决策流 POC（机制①②：卡片抽取 + 挂起人审 + deny 理由回传 + 模型改道）', () => {
  it('红卡挂起时 loop 暂停；翻案理由回传后模型改道；蓝卡静默放行', async () => {
    // 剧本：模型先想写 sqlite（违反 spec → 红卡翻案），被拒后改写 postgres（spec 未指定文件名 → 蓝卡放行），收尾。
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'write_file', { path: 'store/db.sqlite', content: 'CREATE TABLE t;' }),
      toolCallResponse('c2', 'write_file', { path: 'store/schema.postgres.sql', content: 'CREATE TABLE t;' }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    const written: string[] = []
    ctx.tools.register(defineContentToolFixture({
      name: 'write_file', description: 'write a file',
      parameters: { path: { type: 'string', required: true }, content: { type: 'string', required: true } },
      async execute({ path }) { written.push(path as string); return [{ type: 'text', text: 'ok' }] },
    }))
    const agent = await ctx.agentLoop.create(SessionId('poc-red-blue'), { provider: 'mock', model: 'mock' })

    const cards: Card[] = []
    const humanVerdict = Promise.withResolvers<PreToolDecision>()
    let hungAt: number | undefined
    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      if (exec.name !== 'write_file') return next()
      const conflict = JSON.stringify(exec.arguments).includes('sqlite')
      if (conflict) {
        cards.push({ kind: 'red', tool: exec.name, args: exec.arguments })
        hungAt = adapter.requests.length
        return humanVerdict.promise // 挂起：等"人"点卡
      }
      cards.push({ kind: 'blue', tool: exec.name, args: exec.arguments })
      return next() // 蓝卡：静默记录、不打断
    })

    send(agent, '建一个数据库')
    // 挂起验证：给 loop 足够时间“跑过头”，若它没停，工具会执行、模型会被再次调用。
    await sleep(150)
    expect(hungAt).toBe(1)             // 卡片确实在第 1 次模型调用后弹出
    expect(written).toEqual([])         // 工具没执行 —— loop 真的停住等人
    expect(adapter.requests.length).toBe(1) // 也没有下一次模型调用

    // “人”点了翻案：附理由拒绝
    humanVerdict.resolve({ kind: 'deny', reason: '翻案：spec 要求存储用 Postgres，不允许 SQLite' })
    await waitForIdle(ctx, agent)

    // 理由回传：模型看到的 tool/result 是 isError 且带翻案理由
    const result = events(agent).find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.message.content[0].isError).toBe(true)
    expect(result?.type === 'tool/result'
      && result.data.message.content[0].content.some(b => b.type === 'text' && b.text.includes('Postgres'))).toBe(true)
    // 第 2 次模型调用的上下文里能看到翻案理由（模型据此改道）
    expect(requestText(adapter.requests[1]!)).toContain('Postgres')

    // 模型改道后走了蓝卡：postgres 文件写成，sqlite 从未落盘
    expect(written).toEqual(['store/schema.postgres.sql'])
    expect(cards.map(c => c.kind)).toEqual(['red', 'blue'])
    // 卡片拿到完整入参（机制③时间线的数据源）
    expect(cards[0]!.args).toMatchObject({ path: 'store/db.sqlite' })
  })
})

describe('决策流 POC（机制②：inject 注入只向前生效）', () => {
  it('翻案约束出现在后续模型调用里，且不改写历史', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { text: 'step1' }),
      textResponse('收到'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'echo', description: 'echo', parameters: { text: { type: 'string', required: true } },
      async execute({ text }) { return [{ type: 'text', text: text as string }] },
    }))
    const agent = await ctx.agentLoop.create(SessionId('poc-inject'), { provider: 'mock', model: 'mock' })

    const CONSTRAINT = '在案约束：后续所有界面文案一律用中文'
    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      // 第一次工具调用时，"人"在侧栏翻了个案 → 注入在案约束
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: CONSTRAINT }],
        source: { kind: 'plugin', plugin: 'decision-stream' },
      }))
      return next()
    })

    send(agent, '开始干活')
    await waitForIdle(ctx, agent)

    expect(adapter.requests.length).toBe(2)
    expect(requestText(adapter.requests[0]!)).not.toContain('在案约束') // 注入前的调用不受影响
    expect(requestText(adapter.requests[1]!)).toContain(CONSTRAINT)     // 下一步起生效 —— 只向前
  })
})

describe('决策流 POC（D4 第三档：紧急叫停）', () => {
  it('红卡挂起中人拉闸：任务中止、工具从未执行、不再有模型调用', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'write_file', { path: 'store/db.sqlite', content: 'x' }),
      textResponse('不应该走到这里'),
    ])
    const ctx = await harness(adapter)
    let ran = false
    ctx.tools.register(defineContentToolFixture({
      name: 'write_file', description: 'write', parameters: { path: { type: 'string', required: true }, content: { type: 'string', required: true } },
      async execute() { ran = true; return [{ type: 'text', text: 'ok' }] },
    }))
    const agent = await ctx.agentLoop.create(SessionId('poc-cancel'), { provider: 'mock', model: 'mock' })

    const humanVerdict = Promise.withResolvers<PreToolDecision>()
    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      if (exec.name !== 'write_file') return next()
      // 关键：挂起的 gate 必须观察 exec.signal —— registry 不会抛弃 pending promise，
      // 叫停时插件要自己收敛（真插件同样要这么写）。
      exec.signal.addEventListener('abort', () => {
        humanVerdict.resolve({ kind: 'deny', reason: '已被人工叫停' })
      }, { once: true })
      return humanVerdict.promise
    })

    send(agent, '建一个数据库')
    await sleep(100) // 卡片挂起中
    agent.cancel({ kind: 'user' }) // 人按下急刹 → signal abort → gate 收敛
    await waitForIdle(ctx, agent)
    await sleep(100)

    expect(ran).toBe(false)                  // 工具从未执行
    expect(adapter.requests.length).toBe(1)  // 叫停后没有新的模型调用
  })
})
