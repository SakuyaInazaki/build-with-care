import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as DecisionStream from './index.js'
import { ASK_USER_DENY_REASON } from './mapping.js'

let ctx: Context | undefined
let eventsDir: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (eventsDir) await rm(eventsDir, { recursive: true, force: true })
  eventsDir = undefined
})

async function boot(): Promise<Context> {
  eventsDir = await mkdtemp(join(tmpdir(), 'decision-stream-dsh-events-'))
  ctx = new Context()
  await ctx.plugin(Loader, { baseUrl: import.meta.url })
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@decision-stream/dsh-plugin', DecisionStream],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  for (const name of modules.keys()) {
    if (name === '@decision-stream/dsh-plugin') continue
    await ctx.loader.create({ name })
  }
  return ctx
}

describe('DeepSeek Harness 0.1.3 Loader composition', () => {
  it('registers events and keeps ask_user_question denied after a force-allow listener', async () => {
    const context = await boot()
    const stages: string[] = []
    const body = vi.fn(async () => ({}))
    context.on('tools/pre-execute', async (exec, next) => {
      stages.push('pre')
      if (exec.name === 'ask_user_question') return { kind: 'allow' }
      return next()
    })
    context.on('tools/post-execute', async (_exec, _result, next) => {
      stages.push('post')
      return next()
    })
    context.on('tools/result', () => { stages.push('result'); return undefined })
    context.tools.register(defineTool({
      name: 'ask_user_question', description: 'test ask tool', parameters: {},
      output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: () => [] },
      execute: body,
    }))
    await context.loader.create({
      name: '@decision-stream/dsh-plugin',
      config: { baseUrl: 'http://127.0.0.1:1', eventsDir, log: () => undefined },
    })
    await context.loader.await()

    expect(context.tools.schemas().map(tool => tool.name)).toContain('declare_decision')
    const result = await context.tools.execute({
      callId: 'ask-loader' as never,
      name: 'ask_user_question',
      arguments: {},
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
    expect(result.error?.message).toContain(ASK_USER_DENY_REASON)
    expect(body).not.toHaveBeenCalled()
    expect(stages).toEqual(['pre', 'post', 'result'])
  })

  it('mirrors session, turn, step, and fork lifecycle from the 0.1.3 session API', async () => {
    const context = await boot()
    await context.loader.create({
      name: '@decision-stream/dsh-plugin',
      config: { baseUrl: 'http://127.0.0.1:1', eventsDir, log: () => undefined },
    })
    await context.loader.await()

    const parent = context.sessions.create(SessionId('parent'))
    parent.append('turn/start', { turn: 1 })
    parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const child = context.sessions.fork(parent, undefined, SessionId('child'))
    child.append('turn/start', { turn: 2 })
    child.append('step/start', { turn: 2, step: 1 })
    child.append('step/end', { turn: 2, step: 1 })
    child.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

    const parentEvents = (await readFile(join(eventsDir!, 'parent.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type: string })
    const childEvents = (await readFile(join(eventsDir!, 'child.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type: string; payload?: { parentSessionId?: string } })
    expect(parentEvents.map(event => event.type)).toEqual(['session/start', 'turn/start', 'turn/end'])
    expect(childEvents.map(event => event.type)).toEqual(['session/fork', 'turn/start', 'step/start', 'step/end', 'turn/end'])
    expect(childEvents[0]?.payload?.parentSessionId).toBe('parent')
  })
})
