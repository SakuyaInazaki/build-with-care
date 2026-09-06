import pw from '/Users/sakimi/Desktop/build-with-care/decision-desk/node_modules/playwright-core/index.js'
const { chromium } = pw
const BASE = 'http://127.0.0.1:4488'
const OUT = '/Users/sakimi/Desktop/build-with-care/promo/videos/kanzheban-promo/capture/screenshots'
const browser = await chromium.launch({ executablePath: chromium.executablePath(), args: ['--force-color-profile=srgb'] })
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2, locale: 'zh-CN' })
await ctx.addInitScript(() => { try { localStorage.setItem('kanzheban.landing-entered', 'yes') } catch {} })
const page = await ctx.newPage()
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await wait(1500)
await page.getByText('帮我构建一个网页版超级马里奥', { exact: false }).first().click()
await wait(1800)
// open the stopped/blocked section and find a card that carries a gate (four actions)
await page.locator('.closed-items summary').click()
await wait(900)
const cards = page.locator('.closed-items .decision-card')
const n = await cards.count()
console.log('closed cards', n)
for (let i = 0; i < n; i += 1) {
  await cards.nth(i).click()
  await wait(900)
  const stop = page.locator('#decision-detail .stop-action')
  if (await stop.count()) {
    await page.locator('#decision-detail').scrollIntoViewIfNeeded()
    await wait(700)
    await page.screenshot({ path: `${OUT}/04b-gate-actions.png` })
    console.log('captured gate actions from closed card', i)
    // tight crop on the four actions
    const box = await page.locator('#decision-detail').boundingBox()
    await page.screenshot({ path: `${OUT}/04c-gate-actions-crop.png`, clip: { x: box.x, y: Math.max(0, box.y), width: box.width, height: Math.min(box.height, 1080 - Math.max(0, box.y)) } })
    break
  }
  await cards.nth(i).click()
  await wait(300)
}
await browser.close()
