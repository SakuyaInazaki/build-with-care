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
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage()
  await page.addInitScript(() => {
    window.testFocused = true
    window.testNotifications = []
    window.testPermissionRequests = 0
    window.testStreams = []
    document.hasFocus = () => window.testFocused
    window.Notification = class {
      static permission = 'default'
      static async requestPermission() { window.testPermissionRequests++; this.permission = 'granted'; return 'granted' }
      constructor(title, options) { this.title = title; this.options = options; window.testNotifications.push(this) }
      close() { this.closed = true }
    }
    window.EventSource = class extends EventTarget {
      constructor(url) { super(); this.url = url; window.testStreams.push(this) }
      close() { this.closed = true }
    }
  })
  const run = {
    id: 'notify-test', title: '提醒测试任务', prompt: '提醒测试任务', mode: 'live', status: 'running', revision: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    constraints: [], steps: [], decisions: [], gates: [], interventions: [], verifications: [], messages: [], files: [], lastEventSeq: 0,
  }
  let backendVersion = 'unified-work-units-v1'
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { runs: [run], settings: { configured: true }, backendVersion } }))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole('button', { name: run.title, exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.testPermissionRequests), 0)
  assert.equal(await page.evaluate(() => window.testStreams.some(source => source.url.includes('notify-test'))), true)
  await page.getByRole('button', { name: '开启桌面提醒', exact: true }).click()
  assert.equal(await page.evaluate(() => window.testPermissionRequests), 1)
  const send = async state => page.evaluate(state => {
    for (const source of window.testStreams.filter(source => !source.closed)) source.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(state) }))
  }, state)
  run.status = 'waiting'
  run.gates = [{ id: 'gate1', status: 'pending' }]
  await send(run)
  await page.getByRole('alert', { name: '待处理提醒' }).waitFor()
  assert.equal(await page.evaluate(() => window.testNotifications.length), 0)
  await page.evaluate(() => { window.testFocused = false; window.dispatchEvent(new Event('blur')) })
  await page.waitForFunction(() => window.testNotifications.length === 1)
  assert.equal(await page.title(), '（1）待处理 · 看着办')
  await send({ ...run, lastEventSeq: 50 })
  assert.equal(await page.evaluate(() => window.testNotifications.length), 1)
  await page.evaluate(() => window.testNotifications[0].onclick())
  await page.getByRole('heading', { name: '决策看板', exact: true }).waitFor()
  run.gates = []
  run.status = 'running'
  await send(run)
  await page.waitForFunction(() => !document.querySelector('.attention-prompt'))
  assert.equal(await page.evaluate(() => window.testNotifications[0].closed), true)
  // A distinct required action gets its own notification.
  run.reviewFailure = { stepId: 'review1', message: 'Private diagnostic must not appear' }
  await send(run)
  await page.waitForFunction(() => window.testNotifications.length === 2)
  assert.ok(!(await page.evaluate(() => window.testNotifications[1].options.body)).includes('Private diagnostic'))
  await page.getByRole('button', { name: '桌面提醒已开启', exact: true }).click()
  assert.equal(await page.evaluate(() => window.testNotifications[1].closed), true)
  await page.reload()
  await page.getByRole('button', { name: '开启桌面提醒', exact: true }).waitFor()
  await page.getByRole('button', { name: '开启桌面提醒', exact: true }).click()
  await page.evaluate(() => { window.testFocused = false; window.dispatchEvent(new Event('blur')) })
  assert.equal(await page.evaluate(() => window.testNotifications.length), 0)
  await page.evaluate(() => { Notification.permission = 'denied'; window.dispatchEvent(new Event('focus')) })
  await page.getByRole('button', { name: '开启桌面提醒', exact: true }).click()
  await page.getByText('通知权限已被关闭，请在浏览器的网站设置中允许通知。', { exact: true }).waitFor()
  assert.equal(await page.getByRole('alert', { name: '待处理提醒' }).count(), 1)
  await page.getByRole('button', { name: '关闭这条提醒', exact: true }).click()
  assert.equal(await page.getByRole('alert', { name: '待处理提醒' }).count(), 0)
  await send({ ...run, lastEventSeq: 51 })
  assert.equal(await page.getByRole('alert', { name: '待处理提醒' }).count(), 0)
  assert.equal(await page.title(), '（1）待处理 · 看着办')
  await page.reload()
  await page.getByRole('button', { name: run.title, exact: true }).waitFor()
  assert.equal(await page.getByRole('alert', { name: '待处理提醒' }).count(), 0)
  run.reviewFailure = { stepId: 'review2', message: 'A new action' }
  await send(run)
  await page.getByRole('alert', { name: '待处理提醒' }).waitFor()
  console.log('PASS: explicit permission, background subscription, banner, notification, deduplication, click navigation, cleanup, mute/reload, denied fallback, dismiss persists across replay/reload without resolving action, distinct action still appears')
  await page.getByRole('button', { name: run.title, exact: true }).click()
  run.status = 'error'
  run.reviewFailure = undefined
  run.error = '本轮已达到 30 次模型请求上限，请检查过程后新建任务'
  await send(run)
  await page.getByText(run.error, { exact: true }).waitFor()
  backendVersion = 'unified-work-units-v3'
  await page.evaluate(() => {
    for (const source of window.testStreams.filter(source => !source.closed)) source.onerror?.(new Event('error'))
  })
  await page.getByText('此前运行因旧版次数上限中断。上限已移除，点击“继续任务”即可接着完成。', { exact: true }).waitFor()
  await send(run)
  await page.getByRole('button', { name: '继续任务', exact: true }).waitFor()
  assert.equal(await page.getByText('正在重新连接。当前显示最后同步的记录。', { exact: true }).count(), 0)
  console.log('PASS: reconnect refreshes backend capability and keeps historical error resumable without creating a task')
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
