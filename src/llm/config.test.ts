import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeLlmConfig, llmConfigWarnings, loadDotEnv, loadLlmConfig, parseDotEnv } from './config.js'

describe('llm config', () => {
  it('parses .env lines with quotes, comments and export', () => {
    const parsed = parseDotEnv(`# comment\nexport A=1\nB="two words" \nC='single # not comment'\nD=plain # trailing comment\nE=\n\nINVALID LINE\nF="line\\nbreak"\n`)
    expect(parsed).toEqual({ A: '1', B: 'two words', C: 'single # not comment', D: 'plain', E: '', F: 'line\nbreak' })
  })

  it('reads three roles from env; recorder defaults to judge field by field', () => {
    const config = loadLlmConfig({ dotenv: false, env: {
      DECISION_STREAM_AGENT_PROVIDER: 'openai', DECISION_STREAM_AGENT_BASE_URL: 'https://api.deepseek.com/v1/', DECISION_STREAM_AGENT_API_KEY: 'sk-agent', DECISION_STREAM_AGENT_MODEL: 'deepseek-chat',
      DECISION_STREAM_JUDGE_PROVIDER: 'anthropic', DECISION_STREAM_JUDGE_API_KEY: 'sk-ant', DECISION_STREAM_JUDGE_MODEL: 'claude-opus-5', DECISION_STREAM_JUDGE_TIMEOUT_MS: '1234',
      DECISION_STREAM_RECORDER_MODEL: 'claude-sonnet-5',
    } })
    expect(config.agent).toEqual({ role: 'agent', provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-agent', model: 'deepseek-chat', timeoutMs: 60000 })
    expect(config.judge).toEqual({ role: 'judge', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant', model: 'claude-opus-5', timeoutMs: 1234 })
    expect(config.recorder).toEqual({ role: 'recorder', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant', model: 'claude-sonnet-5', timeoutMs: 1234 })
  })

  it('treats roles without key+model as unconfigured, infers provider from the base url, ignores bad timeouts', () => {
    const config = loadLlmConfig({ dotenv: false, env: {
      DECISION_STREAM_AGENT_MODEL: 'no-key',
      DECISION_STREAM_JUDGE_API_KEY: 'k', DECISION_STREAM_JUDGE_MODEL: 'm', DECISION_STREAM_JUDGE_BASE_URL: 'https://gw.example.com/anthropic', DECISION_STREAM_JUDGE_TIMEOUT_MS: 'soon',
    } })
    expect(config.agent).toBeNull()
    expect(config.judge).toMatchObject({ provider: 'anthropic', baseUrl: 'https://gw.example.com/anthropic', timeoutMs: 60000 })
    expect(config.recorder).toMatchObject({ role: 'recorder', model: 'm' })
    expect(loadLlmConfig({ dotenv: false, env: { DECISION_STREAM_AGENT_API_KEY: 'k', DECISION_STREAM_AGENT_MODEL: 'm', DECISION_STREAM_AGENT_PROVIDER: 'Claude' } }).agent?.provider).toBe('anthropic')
  })

  it('process env wins over .env and .env only fills gaps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-env-'))
    writeFileSync(join(dir, '.env'), 'DECISION_STREAM_AGENT_API_KEY=from-file\nDECISION_STREAM_AGENT_MODEL=file-model\n')
    expect(loadDotEnv(dir)).toEqual({ DECISION_STREAM_AGENT_API_KEY: 'from-file', DECISION_STREAM_AGENT_MODEL: 'file-model' })
    expect(loadDotEnv(join(dir, 'missing'))).toEqual({})
    const config = loadLlmConfig({ root: dir, env: { DECISION_STREAM_AGENT_MODEL: 'env-model', DECISION_STREAM_AGENT_API_KEY: '' } })
    expect(config.agent).toMatchObject({ apiKey: 'from-file', model: 'env-model' })
    expect(loadLlmConfig({ root: dir, env: {}, dotenv: false }).agent).toBeNull()
  })

  it('describes without leaking keys and warns when judge shares the agent model', () => {
    const config = loadLlmConfig({ dotenv: false, env: {
      DECISION_STREAM_AGENT_API_KEY: 'sk-secret-agent-123', DECISION_STREAM_AGENT_MODEL: 'deepseek-chat',
      DECISION_STREAM_JUDGE_API_KEY: 'sk-secret-judge-456', DECISION_STREAM_JUDGE_MODEL: 'deepseek-chat',
    } })
    const described = describeLlmConfig(config)
    expect(described).toEqual({
      agent: { configured: true, provider: 'openai', model: 'deepseek-chat' },
      judge: { configured: true, provider: 'openai', model: 'deepseek-chat' },
      recorder: { configured: true, provider: 'openai', model: 'deepseek-chat' },
    })
    expect(JSON.stringify(described)).not.toContain('sk-secret')
    expect(llmConfigWarnings(config)[0]).toContain('异源')
    expect(describeLlmConfig(loadLlmConfig({ dotenv: false, env: {} }))).toEqual({
      agent: { configured: false, provider: null, model: null }, judge: { configured: false, provider: null, model: null }, recorder: { configured: false, provider: null, model: null },
    })
  })
})
