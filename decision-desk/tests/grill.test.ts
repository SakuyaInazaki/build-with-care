import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { fixture } from './helpers.js'
import { confirmGrill, emptyGrill, nextGrill } from '../server/grill.js'
import { complete } from '../server/models.js'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.cleanup()
    rmSync(`${f.dir}.deletion-audit.jsonl`, { force: true })
  }
})
const setup = () => {
  const f = fixture()
  fixtures.push(f)
  return f
}
const response = (content: unknown) => ({
  content: JSON.stringify(content),
  calls: [],
  finishReason: 'stop',
})

it('isolates Grill context from execution and does not call tools', async () => {
  const { manager } = setup()
  const run = manager.create('做一个活动页面', 'demo')
  run.grill = emptyGrill()
  run.messages.push({
    id: 'private',
    role: 'agent',
    text: 'EXECUTION_HISTORY_SENTINEL',
    at: run.createdAt,
  })
  const ask = vi
    .fn<typeof complete>()
    .mockResolvedValue(
      response({
        kind: 'question',
        title: '数据保留多久？',
        reason: '决定存储方式',
        options: ['刷新清空', '永久保存'],
      }),
    )
  const next = await nextGrill(run, manager.settings, { round: 0 }, ask)
  expect(next.round).toBe(1)
  expect(next.question?.options).toHaveLength(2)
  expect(JSON.stringify(ask.mock.calls[0][1])).not.toContain('EXECUTION_HISTORY_SENTINEL')
  expect(ask.mock.calls[0][2]).toBeUndefined()
  expect(run.steps).toHaveLength(0)
  expect(run.grill.status).toBe('idle')
})

it('rejects stale answers and a sixth question, then permits final confirmation retry', async () => {
  const { manager } = setup()
  const run = manager.create('做一个页面', 'demo')
  run.grill = {
    ...emptyGrill(),
    status: 'question',
    round: 5,
    question: { title: '第五题', reason: '', options: ['是', '否'] },
    answers: Array.from({ length: 4 }, () => ({ question: '前题', answer: '已回答' })),
  }
  const ask = vi
    .fn<typeof complete>()
    .mockResolvedValue(
      response({ kind: 'question', title: '第六题', reason: '', options: ['是', '否'] }),
    )
  await expect(nextGrill(run, manager.settings, { round: 4, answer: '是' }, ask)).rejects.toThrow(
    '问题已更新',
  )
  expect(ask).not.toHaveBeenCalled()
  await expect(nextGrill(run, manager.settings, { round: 5, answer: '是' }, ask)).rejects.toThrow(
    '五轮',
  )
  expect(run.grill.answers).toHaveLength(4)
  ask.mockResolvedValue(
    response({ kind: 'confirmation', constraints: ['中文页面'], assumptions: [], unresolved: [] }),
  )
  expect((await nextGrill(run, manager.settings, { round: 5, answer: '是' }, ask)).status).toBe(
    'confirm',
  )
})

it('blocks execution until assumptions and unresolved items are explicitly confirmed', async () => {
  const { manager } = setup()
  const run = manager.create('做一个页面', 'demo', true)
  await expect(manager.start(run.id, ['中文页面'])).rejects.toThrow('确认')
  expect(run.steps).toHaveLength(0)
  const grill = {
    ...emptyGrill(),
    status: 'confirm' as const,
    constraints: ['中文页面'],
    assumptions: ['单页结构'],
    unresolved: ['活动日期'],
  }
  const approval = { confirmed: true, acceptedAssumptions: false, unresolved: [] }
  expect(() => confirmGrill(grill, grill.constraints, approval)).toThrow('补全')
  expect(() =>
    confirmGrill(grill, grill.constraints, { ...approval, acceptedAssumptions: true }),
  ).toThrow('未决')
  expect(
    confirmGrill(grill, ['用户修改后的要求'], {
      ...approval,
      acceptedAssumptions: true,
      unresolved: [{ item: '活动日期', answer: '保持未指定' }],
    }),
  ).toEqual(['用户修改后的要求', '单页结构', '活动日期：保持未指定'])
})

it('allows identical model providers and physically deletes a task while retaining an independent audit', async () => {
  const { manager, dir } = setup()
  const config = {
    baseUrl: 'http://127.0.0.1:4999/v1',
    model: 'same-model',
    family: 'same',
    apiKey: '',
  }
  expect(
    manager.updateSettings({
      worker: { ...config },
      reviewer: { ...config },
      reviewTimeoutMs: 4000,
      gateTimeoutMs: 90000,
    }).configured,
  ).toBe(true)
  expect(manager.publicSettings().gateTimeoutMs).toBe(90000)
  const run = manager.create('测试数据删除', 'live', true)
  const directory = manager.store.directory(run.id)
  await manager.delete(run.id)
  expect(existsSync(directory)).toBe(false)
  expect(() => manager.get(run.id)).toThrow('不存在')
  const audit = readFileSync(`${dir}.deletion-audit.jsonl`, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(audit.map((item) => item.phase)).toEqual(['requested', 'completed'])
  expect(audit[0].operationId).toBe(audit[1].operationId)
  expect(audit[0].runId).toBe(run.id)
})
