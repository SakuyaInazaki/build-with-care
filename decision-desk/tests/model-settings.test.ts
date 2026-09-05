import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Manager, defaultSettings } from '../server/manager.js'
import { isDeepSeekBaseUrl, DEEPSEEK_BASE_URL } from '../shared/model-presets.js'
import { fixture } from './helpers.js'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const f of fixtures.splice(0)) await f.cleanup()
})

it('configures both DeepSeek roles from one environment key without forwarding it to a custom endpoint', () => {
  for (const role of ['WORKER', 'REVIEWER'])
    for (const field of ['BASE_URL', 'MODEL', 'FAMILY', 'API_KEY'])
      vi.stubEnv(`${role}_${field}`, '')
  vi.stubEnv('DEEPSEEK_API_KEY', 'environment-test-key')
  const defaults = defaultSettings()
  expect(defaults.worker).toEqual(defaults.reviewer)
  expect(defaults.worker.model).toBe('deepseek-v4-flash')
  expect(defaults.worker.apiKey).toBe('environment-test-key')
  vi.stubEnv('REVIEWER_BASE_URL', 'https://custom.example/v1')
  expect(defaultSettings().reviewer.apiKey).toBe('')
  expect(defaultSettings().reviewer.model).toBe('')
  vi.stubEnv('REVIEWER_API_KEY', 'role-specific-test-key')
  expect(defaultSettings().reviewer.apiKey).toBe('role-specific-test-key')
})

it('only recognizes equivalent official DeepSeek API addresses', () => {
  for (const url of [
    DEEPSEEK_BASE_URL,
    `${DEEPSEEK_BASE_URL}/v1/`,
    `${DEEPSEEK_BASE_URL}/v1/chat/completions`,
  ])
    expect(isDeepSeekBaseUrl(url)).toBe(true)
  for (const url of [
    'https://api.deepseek.com.evil.example',
    'https://api.deepseek.com/custom',
    'https://key@api.deepseek.com',
    'https://api.deepseek.com?proxy=custom',
    'http://api.deepseek.com',
    'https://api.deepseek.com:8443',
  ])
    expect(isDeepSeekBaseUrl(url)).toBe(false)
})

it('retains a shared key across official URL aliases but drops it for a different service', () => {
  const f = fixture()
  fixtures.push(f)
  const model = {
    baseUrl: `${DEEPSEEK_BASE_URL}/v1`,
    model: 'deepseek-v4-flash',
    family: 'deepseek',
    apiKey: 'shared-test-key',
  }
  f.manager.updateSettings({ worker: { ...model }, reviewer: { ...model }, reviewTimeoutMs: 8000 })
  const updated = f.manager.updateSettings({
    worker: { ...model, baseUrl: DEEPSEEK_BASE_URL, model: 'deepseek-v4-pro', apiKey: '' },
    reviewer: { ...model, baseUrl: DEEPSEEK_BASE_URL, apiKey: '' },
    reviewTimeoutMs: 8000,
  })
  expect(updated.sharedDeepSeekKey).toBe(true)
  expect(JSON.stringify(updated)).not.toContain('shared-test-key')
  expect(f.manager.settings.worker.apiKey).toBe('shared-test-key')
  const custom = { ...model, baseUrl: 'https://custom.example/v1', apiKey: '' }
  expect(
    f.manager.updateSettings({ worker: custom, reviewer: { ...model }, reviewTimeoutMs: 8000 })
      .sharedDeepSeekKey,
  ).toBe(false)
  expect(f.manager.settings.worker.apiKey).toBe('')
})

it('does not describe two different saved keys as one shared key', () => {
  const f = fixture()
  fixtures.push(f)
  const model = {
    baseUrl: DEEPSEEK_BASE_URL,
    model: 'deepseek-v4-flash',
    family: 'deepseek',
    apiKey: 'first-test-key',
  }
  expect(
    f.manager.updateSettings({
      worker: { ...model },
      reviewer: { ...model, apiKey: 'second-test-key' },
      reviewTimeoutMs: 8000,
    }).sharedDeepSeekKey,
  ).toBe(false)
})

it('restores saved models, keys and timeouts after restart without exposing secrets publicly', async () => {
  const f = fixture()
  fixtures.push(f)
  const model = {
    baseUrl: DEEPSEEK_BASE_URL,
    model: 'deepseek-v4-pro',
    family: 'deepseek',
    apiKey: 'persisted-test-key',
    reasoningEffort: 'max' as const,
  }
  f.manager.updateSettings({
    worker: { ...model },
    reviewer: { ...model },
    reviewTimeoutMs: 12000,
    gateTimeoutMs: 180000,
  })
  await f.manager.dispose()
  const restored = new Manager(f.dir)
  expect(restored.settings.worker).toEqual(model)
  expect(restored.settings.reviewer).toEqual(model)
  expect(restored.settings.reviewTimeoutMs).toBe(12000)
  expect(restored.settings.gateTimeoutMs).toBe(180000)
  expect(restored.publicSettings().configured).toBe(true)
  expect(JSON.stringify(restored.publicSettings())).not.toContain(model.apiKey)
  expect(restored.list()).toEqual([])
  const file = path.join(f.dir, '.settings.json')
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(readdirSync(f.dir)).toEqual(['.settings.json'])
  restored.updateSettings({
    worker: { ...model, apiKey: '', model: 'deepseek-v4-flash' },
    reviewer: { ...model, apiKey: '', baseUrl: 'https://custom.example/v1' },
    reviewTimeoutMs: 8000,
  })
  await restored.dispose()
  const restartedAgain = new Manager(f.dir)
  expect(restartedAgain.settings.worker.apiKey).toBe(model.apiKey)
  expect(restartedAgain.settings.worker.model).toBe('deepseek-v4-flash')
  expect(restartedAgain.settings.reviewer.apiKey).toBe('')
  expect(restartedAgain.settings.gateTimeoutMs).toBe(180000)
  await restartedAgain.dispose()
})

it('does not report success or change memory when persistence fails', () => {
  const f = fixture()
  fixtures.push(f)
  const previous = structuredClone(f.manager.settings)
  mkdirSync(path.join(f.dir, '.settings.json'))
  expect(() =>
    f.manager.updateSettings({
      worker: { ...previous.worker, apiKey: 'unsaved-test-key' },
      reviewer: { ...previous.reviewer, apiKey: 'unsaved-test-key' },
      reviewTimeoutMs: 10000,
    }),
  ).toThrow('模型配置未能保存到本机，原配置保持不变。')
  expect(f.manager.settings).toEqual(previous)
  expect(readdirSync(f.dir)).toEqual(['.settings.json'])
})

it('preserves an unreadable saved configuration without exposing its contents', () => {
  const f = fixture()
  fixtures.push(f)
  const file = path.join(f.dir, '.settings.json')
  const damaged = '{"apiKey":"private-test-value",'
  writeFileSync(file, damaged, { mode: 0o600 })
  expect(() => new Manager(f.dir)).toThrow('无法读取已保存的模型配置，原配置文件已保留。')
  expect(readFileSync(file, 'utf8')).toBe(damaged)
})
