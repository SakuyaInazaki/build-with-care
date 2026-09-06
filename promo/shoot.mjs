import pw from '/Users/sakimi/Desktop/build-with-care/decision-desk/node_modules/playwright-core/index.js'
const { chromium } = pw

const BASE = 'http://127.0.0.1:4488'
const OUT = '/Users/sakimi/Desktop/build-with-care/promo/videos/kanzheban-promo/capture/screenshots'
const browser = await chromium.launch({
  executablePath: chromium.executablePath(),
  args: ['--force-color-profile=srgb', '--font-render-hinting=none'],
})
const ctx = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 2,
  locale: 'zh-CN',
})
await ctx.addInitScript(() => { try { localStorage.setItem('kanzheban.landing-entered', 'yes') } catch {} })
const page = await ctx.newPage()
const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log('shot', name)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// --- workspace overview
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await wait(1500)
await shot('01-overview')

// --- open the task -> board
await page.getByText('帮我构建一个网页版超级马里奥', { exact: false }).first().click()
await wait(1800)
await shot('02-board')

// --- expand the confirmed requirements (the continuity object's origin)
await page.locator('.constraint-toggle').click()
await wait(900)
await shot('03-constraints-open')
await page.locator('.constraint-toggle').click()
await wait(600)

// --- card detail (two-column: your requirement vs agent action)
await page.locator('.board-lane.lane-validation .decision-card').first().click()
await wait(1300)
await page.locator('#decision-detail').scrollIntoViewIfNeeded()
await wait(900)
await shot('04-card-detail')
await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
await wait(600)

// --- verified lane expanded (green evidence cards)
await page.locator('.board-lane.lane-verified .lane-toggle').click()
await wait(1000)
await shot('03b-verified-open')

// --- timeline
await page.getByRole('button', { name: '过程时间线' }).click().catch(async () => {
  await page.getByText('过程时间线', { exact: true }).click()
})
await wait(1500)
await shot('05-timeline')

// --- artifacts & verification
await page.getByText('成果与验证', { exact: true }).click()
await wait(2500)
await shot('06-artifacts')

// --- my judgements report
await page.getByText('我的判断', { exact: true }).click()
await wait(1500)
await shot('07-record')

// --- welcome landing
await page.goto(`${BASE}/welcome`, { waitUntil: 'networkidle' })
await wait(2500)
await shot('08-welcome-start')
const scroller = page.locator('.paper-landing__scroll')
for (const [i, frac] of [0.35, 0.7, 1].entries()) {
  await page.evaluate((f) => {
    const el = document.querySelector('.paper-landing__scroll')
    const max = el.scrollHeight - el.clientHeight
    el.scrollTo({ top: max * f, behavior: 'instant' })
  }, frac)
  await wait(1600)
  await shot(`09-welcome-${i + 1}`)
}
console.log('progress', await page.locator('.paper-landing__stage').getAttribute('data-progress'))

await browser.close()
