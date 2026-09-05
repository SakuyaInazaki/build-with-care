// Isolated browser regression: compiled frontend, mocked API, no user data or model calls.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(new URL('../../decision-desk/package.json', import.meta.url))
const { chromium } = require('@playwright/test')
const root = fileURLToPath(new URL('../dist/', import.meta.url))
const server = createServer(async (req, res) => {
  try {
    const relative = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html'
    const target = path.resolve(root, relative)
    if (!target.startsWith(root)) throw new Error('Invalid path')
    res.setHeader('Content-Type', target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : 'text/html')
    res.end(await readFile(target))
  } catch { res.writeHead(404).end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
let page
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  page = await browser.newPage()
  page.on('pageerror', error => console.error(error.message))
  const run = {
    id: 'intake-test', title: '多选回归任务', prompt: '多选回归任务', mode: 'live', status: 'ready', revision: 1,
    createdAt: new Date().toISOString(), constraints: [], steps: [], decisions: [], gates: [],
    interventions: [], verifications: [], messages: [], files: [], lastEventSeq: 0,
    grill: { status: 'question', round: 1, answers: [], constraints: [], assumptions: [], unresolved: [],
      question: { title: '需要哪些功能？', reason: '', options: ['搜索', '收藏', '导出'] } },
  }
  const submitted = []
  const events = []
  let detailRequests = 0
  await page.route('**/api/**', async route => {
    const url = route.request().url()
    if (url.endsWith('/bootstrap')) return route.fulfill({ json: { runs: [run], settings: { configured: true } } })
    if (url.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: `event: state\ndata: ${JSON.stringify(run)}\n\n` })
    if (url.endsWith('/events')) return route.fulfill({ json: events })
    if (url.endsWith('/details')) { detailRequests++; return route.fulfill({ json: { completeRecord: true } }) }
    if (url.endsWith('/grill')) {
      submitted.push(route.request().postDataJSON())
      if (submitted.length === 1) return route.fulfill({ status: 503, json: { error: '测试服务暂时不可用' } })
      run.grill.round++
      return route.fulfill({ json: run })
    }
    throw new Error(`Unexpected API call: ${url}`)
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole('button', { name: run.prompt, exact: true }).click()
  const choices = page.getByRole('checkbox')
  await choices.nth(0).check()
  await choices.nth(1).check()
  await choices.nth(1).uncheck()
  assert.equal(await choices.nth(0).isChecked(), true)
  await choices.nth(1).check()
  await page.getByLabel('补充回答', { exact: true }).fill('收藏按日期排序')
  const submit = page.getByRole('button', { name: '确认回答，继续' })
  await submit.click()
  await page.getByRole('alert').waitFor()
  assert.deepEqual(submitted[0], { round: 1, answer: '已选选项：\n- 搜索\n- 收藏\n\n补充回答：\n收藏按日期排序' })
  assert.equal(await choices.nth(0).isChecked(), true)
  assert.equal(await choices.nth(1).isChecked(), true)
  assert.equal(await page.getByLabel('补充回答', { exact: true }).inputValue(), '收藏按日期排序')
  await submit.click()
  await page.waitForFunction(() => document.querySelector('#grill-answer')?.value === '')
  assert.equal(await choices.nth(0).isChecked(), false)
  assert.equal(await choices.nth(1).isChecked(), false)
  await choices.nth(2).check()
  await submit.click()
  await page.waitForFunction(() => !document.querySelector('input:checked'))
  assert.deepEqual(submitted[2], { round: 2, answer: '已选选项：\n- 导出' })
  await page.getByLabel('补充回答', { exact: true }).fill('只需打印')
  run.workUnits = ['one', 'two'].map((id, index) => ({ id, goal: `工作单元目标${index + 1}`, status: 'completed',
    createdAt: '2026-09-05T10:00:00.000Z', closedAt: '2026-09-05T10:01:00.000Z', decisions: [], plan: [], stepIds: [], nextCall: 0, revision: 1 }))
  events.push(...run.workUnits.flatMap((unit, index) => [
    { id: `${unit.id}-start`, seq: index * 3 + 1, type: 'unit.declared', data: { unitId: unit.id }, at: unit.createdAt },
    { id: `${unit.id}-step`, seq: index * 3 + 2, type: 'model.response', data: { unitId: unit.id, model: `独属模型${index + 1}` }, at: unit.createdAt },
    { id: `${unit.id}-end`, seq: index * 3 + 3, type: 'unit.closed', data: { unitId: unit.id }, at: unit.closedAt },
  ]))
  await submit.click()
  await page.waitForFunction(() => document.querySelector('#grill-answer')?.value === '')
  assert.deepEqual(submitted[3], { round: 3, answer: '只需打印' })
  assert.equal(await page.getByRole('radio').count(), 0)
  assert.equal(await page.getByText(/需求澄清 ·|最多 5 题/).count(), 0)
  console.log('PASS: multiple/single/free-text answers, uncheck, retry retention, next-round reset, no round-limit caption')
  await page.getByRole('button', { name: '过程时间线', exact: true }).click()
  await page.locator('.unit-summary').first().waitFor()
  assert.equal(await page.locator('.unit-summary').count(), 2)
  assert.equal(await page.locator('.timeline-rail').count(), 0)
  assert.equal(detailRequests, 0)
  await page.locator('.unit-summary').first().click()
  await page.locator('.timeline-rail').waitFor()
  assert.equal(await page.locator('.timeline-rail .timeline-event').count(), 3)
  assert.ok((await page.locator('.timeline-rail').innerText()).includes('独属模型1'))
  assert.ok(!(await page.locator('.timeline-rail').innerText()).includes('独属模型2'))
  await page.getByRole('button', { name: '原始记录', exact: true }).click()
  await page.getByText('"completeRecord": true', { exact: false }).waitFor()
  assert.equal(detailRequests, 1)
  await page.locator('.unit-summary').nth(1).click()
  assert.ok((await page.locator('.timeline-rail').innerText()).includes('独属模型2'))
  assert.ok(!(await page.locator('.timeline-rail').innerText()).includes('独属模型1'))
  await page.getByRole('button', { name: '收起步骤', exact: true }).click()
  assert.equal(await page.locator('.timeline-rail').count(), 0)
  console.log('PASS: unit overview hides steps, selected-unit isolation, on-demand raw detail, collapse')
} catch (error) {
  console.error(await page?.locator('body').innerText())
  throw error
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
