import pw from '/Users/sakimi/Desktop/build-with-care/decision-desk/node_modules/playwright-core/index.js'
const { chromium } = pw
const BASE = 'http://127.0.0.1:4488'
const OUT = '/Users/sakimi/Desktop/build-with-care/promo/videos/kanzheban-promo/capture/screenshots'
const browser = await chromium.launch({ executablePath: chromium.executablePath(), args: ['--force-color-profile=srgb'] })
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1200 }, deviceScaleFactor: 3, locale: 'zh-CN' })
await ctx.addInitScript(() => { try { localStorage.setItem('kanzheban.landing-entered', 'yes') } catch {} })
const page = await ctx.newPage()
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await wait(1600)
// the archived run that never executed: its board is genuinely empty — product chrome, no task content
await page.getByText('已归档', { exact: false }).first().click()
await wait(1200)
const rows = page.locator('button, a').filter({ hasText: '帮我构建一个网页版超级马里奥' })
console.log('archived rows', await rows.count())
await rows.last().click()
await wait(1800)
const board = page.locator('.board')
if (await board.count()) {
  await board.screenshot({ path: `${OUT}/product-board-empty.png` })
  console.log('product-board-empty')
} else {
  console.log('no board; url =', page.url())
}
await browser.close()
