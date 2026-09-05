import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'

mkdirSync('.artifacts', { recursive: true })
async function createDemo(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /开始一次协作/ }).click()
  await page.getByRole('button', { name: '整理需求' }).click()
  await expect(page.getByRole('heading', { name: '这些要求，我们就照着做。' })).toBeVisible()
  await page.getByRole('button', { name: '确认，开始协作' }).click()
  await expect(page.getByText('这一步尚未执行，正在等你。')).toBeVisible({ timeout: 15000 })
}
test('complete correction, inspect actual page behavior, export and reload the evidence', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: /开始一次协作/ }).click()
  await page.screenshot({ path: '.artifacts/01-welcome.png', fullPage: true })
  await createDemo(page)
  await page.screenshot({ path: '.artifacts/02-waiting-for-human.png', fullPage: true })
  await page.getByRole('button', { name: '我来写一句纠正' }).click()
  await page.getByLabel('告诉 Agent，接下来怎么做').fill('只使用页面内存，刷新后清空报名信息')
  await page.getByRole('button', { name: '提交纠正' }).click()
  await expect(page.locator('.status-pill')).toHaveText('本轮已完成', { timeout: 15000 })
  await page.locator('.workspace-tabs').getByRole('button', { name: '成果展示' }).click()
  const preview = page.frameLocator('iframe[title="活动页面预览"]')
  await preview.getByLabel('怎么称呼你？').fill('小周')
  await preview.getByRole('button', { name: '加入这次共创 →' }).click()
  await expect(preview.getByRole('status')).toHaveText('报名成功！已报名 1 人')
  await page.getByRole('button', { name: '刷新成果预览' }).click()
  await expect(preview.getByRole('status')).toHaveText('无需登录，直接报名。')
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: '.artifacts/03-corrected-and-checked.png', fullPage: true })
  await page.getByRole('button', { name: '判断与复盘' }).click()
  await expect(page.getByText('对应静态检查已通过')).toBeVisible()
  await page.getByLabel('复盘记录').fill('涉及用户数据时，先说明保留多久。')
  await page.getByRole('button', { name: '保存这句话' }).click()
  await expect(page.getByRole('button', { name: '已保存' })).toBeVisible()
  const download = page.waitForEvent('download')
  await page.getByRole('link', { name: '导出记录' }).click()
  await (await download).saveAs('.artifacts/decision-record.json')
  await page.screenshot({ path: '.artifacts/04-human-decisions.png', fullPage: true })
  await page.reload()
  await page.getByRole('button', { name: '判断与复盘' }).click()
  await expect(page.getByLabel('复盘记录')).toHaveValue('涉及用户数据时，先说明保留多久。')
  expect(errors).toEqual([])
})
test('stopping a pending write does not save its conflicting content', async ({ page }) => {
  await createDemo(page)
  await page.getByRole('button', { name: '停止任务' }).click()
  await expect(page.locator('.status-pill')).toHaveText('已停止')
  await expect(page.getByRole('button', { name: '调整后续做法' })).toBeDisabled()
  await page.locator('.workspace-tabs').getByRole('button', { name: '成果展示' }).click()
  const iframe = page.locator('iframe[title="活动页面预览"]')
  const source = await iframe.getAttribute('src')
  expect(await (await page.request.get(source!)).text()).not.toContain('localStorage')
})
test('mobile layout fits viewport and supports correcting a pending decision', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: /开始一次协作/ }).click()
  await expect(page.getByRole('button', { name: '整理需求' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: '.artifacts/05-mobile.png', fullPage: true })
  await createDemo(page)
  await page.getByRole('button', { name: '按原要求改正' }).click()
  await expect(page.locator('.status-pill')).toHaveText('本轮已完成', { timeout: 15000 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: '.artifacts/06-mobile-task.png', fullPage: true })
})

test('model settings save without exposing stored passwords when reopened', async ({ page }) => {
  await page.goto('/')
  await page.locator('.topbar-right .icon-button').click()
  const dialog = page.getByRole('dialog')
  const worker = dialog.locator('.model-section').nth(0),
    reviewer = dialog.locator('.model-section').nth(1)
  for (const [section, suffix] of [
    [worker, 'a'],
    [reviewer, 'b'],
  ] as const) {
    await section.getByLabel('接口地址').fill(`https://example-${suffix}.com/v1`)
    await section.getByLabel('模型名称').fill(`test-model-${suffix}`)
    await section.getByLabel('模型来源').fill(`test-family-${suffix}`)
    await section.getByLabel('API 密钥').fill(`ui-secret-${suffix}`)
  }
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('设置已保存')
  await dialog.getByRole('button', { name: '关闭模型设置' }).click()
  await page.locator('.topbar-right .icon-button').click()
  await expect(worker.getByLabel('API 密钥')).toHaveValue('')
  await expect(worker.getByLabel('API 密钥')).toHaveAttribute(
    'placeholder',
    '已设置；地址不变时留空保留',
  )
  expect(
    await page.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    ),
  ).not.toContain('ui-secret')
})

test('shows a large fullscreen result, distinct event filters and ongoing requirements and ideas', async ({
  page,
}) => {
  await createDemo(page)
  const filters = page.locator('.event-filters')
  const blue = await filters.locator('.choice').evaluate((e) => getComputedStyle(e).backgroundColor)
  const red = await filters
    .locator('.conflict')
    .evaluate((e) => getComputedStyle(e).backgroundColor)
  expect(blue).not.toBe(red)
  await filters.getByRole('button', { name: /重要选择/ }).click()
  await expect(page.locator('.step-row.choice')).toHaveCount(1)
  await expect(page.locator('.step-row.conflict')).toHaveCount(0)
  await filters.getByRole('button', { name: /约束冲突/ }).click()
  await expect(page.locator('.step-row.conflict')).toHaveCount(1)
  const composer = page.getByRole('form', { name: '追加要求与想法' })
  await composer
    .getByLabel('补充新的要求或想法')
    .fill('只使用页面内存，刷新后清空；报名名额改为 30 人')
  await composer.getByRole('button', { name: '发送补充' }).click()
  await expect(composer.getByRole('status')).toContainText('新要求已加入')
  await expect(page.locator('.status-pill')).toHaveText('本轮已完成', { timeout: 15000 })
  await expect(page.locator('.human-event').filter({ hasText: '你追加了新要求' })).toContainText(
    '30 人',
  )
  await page.locator('.workspace-tabs').getByRole('button', { name: '成果展示' }).click()
  const frame = page.locator('iframe[title="活动页面预览"]')
  const size = await frame.boundingBox()
  expect(size!.width).toBeGreaterThan(900)
  expect(size!.height).toBeGreaterThanOrEqual(650)
  await expect(page.frameLocator('iframe').locator('#count')).toHaveText('共 30 个名额')
  await page.locator('.large-preview').scrollIntoViewIfNeeded()
  await page.screenshot({ path: '.artifacts/07-large-result.png', fullPage: true })
  await page.getByRole('button', { name: '全屏查看' }).click()
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true)
  await page.screenshot({ path: '.artifacts/08-fullscreen-result.png' })
  await page.getByRole('button', { name: '退出全屏' }).click()
  await composer.getByRole('button', { name: '新想法', exact: true }).click()
  await composer.getByLabel('补充新的要求或想法').fill('是否考虑两栏布局？')
  await composer.getByRole('button', { name: '追加并继续' }).click()
  await expect(composer.getByRole('status')).toContainText('想法已送达')
  await expect(page.locator('.status-pill')).toHaveText('本轮已完成', { timeout: 15000 })
  await expect(page.frameLocator('iframe').locator('#count')).toHaveText('共 30 个名额')
  await page.locator('.workspace-tabs').getByRole('button', { name: '协作时间线' }).click()
  await filters.getByRole('button', { name: /人的补充/ }).click()
  await expect(page.locator('.human-event')).toHaveCount(2)
  await expect(page.locator('.human-event.idea')).toContainText('参考想法 · 未修改约束')
  await page.screenshot({ path: '.artifacts/09-human-additions.png', fullPage: true })
})
