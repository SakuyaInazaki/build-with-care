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
await wait(1500)
await page.getByText('帮我构建一个网页版超级马里奥', { exact: false }).first().click()
await wait(1800)
await page.locator('.board-lane.lane-validation .decision-card').first().click()
await wait(1300)
const cols = page.locator('#decision-detail .comparison > section')
console.log('columns', await cols.count())
await cols.nth(0).screenshot({ path: `${OUT}/crop-col-requirement.png` })
await cols.nth(1).screenshot({ path: `${OUT}/crop-col-action.png` })
console.log('two columns shot')
// the lane headers band — the product's four states, mechanism not task
await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
await wait(500)
await page.locator('.board').screenshot({ path: `${OUT}/crop-board.png` })
await browser.close()
