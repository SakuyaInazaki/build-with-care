import { describe, expect, it } from 'vitest'
import { LlmClient } from './client.js'
import type { LlmConfig, LlmRoleConfig } from './config.js'
import { draftSpecWithLlm, normalizeConstraints } from './spec-draft.js'

const role = (overrides: Partial<LlmRoleConfig> = {}): LlmRoleConfig => ({ role: 'agent', provider: 'openai', baseUrl: 'https://agent.example.com/v1', apiKey: 'k', model: 'deepseek-chat', timeoutMs: 5000, ...overrides })
const reply = (content: string, status = 200): Response => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }), { status })

describe('draftSpecWithLlm', () => {
  it('expands a one-line request into 2–4 short constraints', async () => {
    const seen: string[] = []
    const client = new LlmClient(role(), { fetch: async (url, init) => { seen.push(url, String(init.body)); return reply('{"constraints":["1. 使用 TypeScript 编写","前端不引入外网 CDN。","前端不引入外网 CDN","这一条实在是太长了太长了太长了太长了太长了太长了太长了","必须有 npm test","第五条"]}') } })
    expect(await draftSpecWithLlm('  做一个待办清单  ', { client })).toEqual({ request: '做一个待办清单', constraints: ['使用 TypeScript 编写', '前端不引入外网 CDN', '必须有 npm test', '第五条'], source: 'llm' })
    expect(seen[0]).toBe('https://agent.example.com/v1/chat/completions')
    expect(seen[1]).toContain('做一个待办清单')
  })

  it('returns null when unconfigured, empty, failing, or too thin', async () => {
    const none: LlmConfig = { agent: null, judge: null, recorder: null }
    expect(await draftSpecWithLlm('做一个待办清单', { config: none })).toBeNull()
    expect(await draftSpecWithLlm('   ', { client: new LlmClient(role(), { fetch: async () => reply('{}') }) })).toBeNull()
    expect(await draftSpecWithLlm('x', { client: new LlmClient(role(), { fetch: async () => reply('{}', 500), retries: 0 }) })).toBeNull()
    expect(await draftSpecWithLlm('x', { client: new LlmClient(role(), { fetch: async () => reply('{"constraints":["只有一条"]}') }) })).toBeNull()
    expect(await draftSpecWithLlm('x', { client: new LlmClient(role(), { fetch: async () => reply('不是 JSON') }) })).toBeNull()
  })

  it('prefers the agent model and falls back to the judge model', async () => {
    const urls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request) => { urls.push(String(url)); return reply('{"constraints":["a","b"]}') }) as typeof fetch
    try {
      const judgeOnly: LlmConfig = { agent: null, judge: role({ role: 'judge', baseUrl: 'https://judge.example.com/v1' }), recorder: null }
      expect(await draftSpecWithLlm('x', { config: judgeOnly })).toMatchObject({ constraints: ['a', 'b'] })
      expect(urls[0]).toBe('https://judge.example.com/v1/chat/completions')
      const both: LlmConfig = { ...judgeOnly, agent: role() }
      await draftSpecWithLlm('x', { config: both })
      expect(urls[1]).toBe('https://agent.example.com/v1/chat/completions')
    } finally { globalThis.fetch = originalFetch }
  })

  it('normalizeConstraints accepts bare arrays and rejects junk', () => {
    expect(normalizeConstraints(['a', 3, '', ' b ', 'a'])).toEqual(['a', 'b'])
    expect(normalizeConstraints({ constraints: 'nope' })).toEqual([])
    expect(normalizeConstraints(null)).toEqual([])
  })
})
