import { DSH_TARGET_COMMIT, DSH_TARGET_VERSION } from '../dist/mapping.js'
import * as plugin from '../dist/index.js'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'

if (DSH_TARGET_VERSION !== '0.1.3-alpha.1' || DSH_TARGET_COMMIT !== 'd347e70390') throw new Error('unexpected dsh target lock')
if (plugin.name !== 'decision-stream' || typeof plugin.apply !== 'function') throw new Error('plugin export did not load')

const ctx = new Context()
const logs = []
try {
  await ctx.plugin(Loader, { baseUrl: import.meta.url })
  const modules = new Map([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@decision-stream/dsh-plugin', plugin],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  }
  await ctx.loader.create({ name: '@deepseek-ai/dsh-agent' })
  await ctx.loader.create({ name: '@deepseek-ai/dsh-system-prompt' })
  await ctx.loader.create({ name: '@deepseek-ai/dsh-tools' })
  await ctx.loader.create({
    name: '@decision-stream/dsh-plugin',
    config: { baseUrl: 'http://127.0.0.1:1', eventsDir: '', log: line => logs.push(line) },
  })
  await ctx.loader.await()
  const schemas = ctx.tools.schemas()
  if (!schemas.some(tool => tool.name === 'declare_decision')) throw new Error('declare_decision was not registered')
  ctx.tools.register(defineTool({
    name: 'ask_user_question',
    description: 'smoke-only ask tool',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: () => [],
    },
    async execute() { throw new Error('ask_user_question body must not run') },
  }))
  const result = await ctx.tools.execute({
    callId: 'smoke-ask',
    name: 'ask_user_question',
    arguments: {},
    signal: new AbortController().signal,
  })
  if (!result.isError || !result.error.message.includes('请通过决策流卡片与人沟通')) {
    throw new Error('ask_user_question was not denied by the loaded plugin')
  }
} finally {
  await ctx.fiber.dispose()
}
console.log(`dsh-plugin smoke: real Loader composition registered decision-stream for ${DSH_TARGET_VERSION} @ ${DSH_TARGET_COMMIT}`)
