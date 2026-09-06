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

// tight crop: the two-column decision detail only
await page.locator('.board-lane.lane-validation .decision-card').first().click()
await wait(1300)
await page.locator('#decision-detail').screenshot({ path: `${OUT}/crop-detail.png` })
console.log('crop-detail')

// tight crop: the requirements sheet
await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
await wait(400)
await page.locator('.constraint-toggle').click()
await wait(900)
await page.locator('.constraint-sheet').screenshot({ path: `${OUT}/crop-constraints.png` })
console.log('crop-constraints')
await page.locator('.constraint-toggle').click()
await wait(400)

// tight crop: the judgement report lead
await page.getByText('我的判断', { exact: true }).click()
await wait(1400)
await page.locator('.record-main').screenshot({ path: `${OUT}/crop-record.png` })
console.log('crop-record')

// tight crop: the board lanes only (no sidebar)
await page.getByText('决策看板', { exact: true }).click()
await wait(1200)
await page.locator('.board').screenshot({ path: `${OUT}/crop-board.png` })
console.log('crop-board')
await browser.close()
