import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import path from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { z } from 'zod'
import { Workspace } from './workspace.js'

const selector = z.string().trim().min(1).max(500)
const name = z.string().trim().min(1).max(120)
const checkpoint = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
const globalPart = z.string().regex(/^(?:[a-zA-Z_$][a-zA-Z0-9_$]*|0|[1-9][0-9]{0,3})$/)
const observationSchema = z.discriminatedUnion('kind', [
  z.object({ name, kind: z.literal('visible'), selector }),
  z.object({ name, kind: z.literal('text'), selector }),
  z.object({ name, kind: z.literal('count'), selector }),
  z.object({ name, kind: z.literal('attribute'), selector, attribute: name }),
  z.object({
    name,
    kind: z.literal('computedStyle'),
    selector,
    property: z.string().regex(/^--?[a-z][a-z0-9-]{0,79}$|^[a-z][a-zA-Z0-9]{0,79}$/),
  }),
  z.object({
    name,
    kind: z.literal('boundingBox'),
    selector,
    property: z.enum(['x', 'y', 'width', 'height']),
  }),
  z.object({ name, kind: z.literal('urlPath') }),
  z.object({ name, kind: z.literal('storageCount'), storage: z.enum(['local', 'session']) }),
  z.object({
    name,
    kind: z.literal('storageValue'),
    storage: z.enum(['local', 'session']),
    key: name,
  }),
  z.object({ name, kind: z.literal('consoleErrorCount') }),
  z.object({ name, kind: z.literal('pageErrorCount') }),
  z.object({ name, kind: z.literal('requestFailureCount') }),
  z.object({
    name,
    kind: z.literal('canvas'),
    selector,
    x: z.number().int().min(0).optional(),
    y: z.number().int().min(0).optional(),
    width: z.number().int().min(1).max(8192).optional(),
    height: z.number().int().min(1).max(8192).optional(),
    metric: z.enum(['hash', 'nonTransparentRatio', 'distinctColors', 'meanLuminance']),
  }),
  z.object({ name, kind: z.literal('screenshotHash'), selector: selector.optional() }),
  z.object({ name, kind: z.literal('globalValue'), path: z.array(globalPart).min(1).max(12) }),
])
const stepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reload') }),
  z.object({ kind: z.literal('click'), selector }),
  z.object({ kind: z.literal('fill'), selector, value: z.string().max(4000) }),
  z.object({
    kind: z.literal('key'),
    key: z
      .string()
      .regex(
        /^(?:ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Enter|Space|Escape|Tab|Home|End|PageUp|PageDown|Backspace|Delete|[a-zA-Z0-9])$/,
      ),
    durationMs: z.number().int().min(0).max(2000).default(0),
    selector: selector.optional(),
  }),
  z.object({ kind: z.literal('wait'), ms: z.number().int().min(0).max(3000) }),
  z.object({
    kind: z.literal('observe'),
    checkpoint,
    observations: z.array(observationSchema).min(1).max(16),
  }),
])
const referenceSchema = z.object({ checkpoint, observation: name })
const assertionSchema = z.object({
  name,
  left: referenceSchema,
  operator: z.enum([
    'equals',
    'notEquals',
    'contains',
    'changed',
    'unchanged',
    'greaterThan',
    'lessThan',
    'differenceAtLeast',
  ]),
  expected: z.unknown().optional(),
  compareTo: referenceSchema.optional(),
  minimum: z.number().positive().max(1_000_000_000).optional(),
})

export const behaviorVerifyInputSchema = z
  .object({
    interventionId: z.string().uuid(),
    path: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine((value) => value.toLowerCase().endsWith('.html'), '行为检查入口必须是 HTML 文件。'),
    scenario: z.object({
      title: z.string().trim().min(1).max(200),
      steps: z.array(stepSchema).min(1).max(32),
      assertions: z.array(assertionSchema).min(1).max(16),
    }),
  })
  .superRefine((input, ctx) => {
    if (JSON.stringify(input.scenario).length > 30_000)
      ctx.addIssue({ code: 'custom', path: ['scenario'], message: '行为检查描述过长。' })
    const observations = new Set<string>()
    const checkpoints = new Set<string>()
    let observationCount = 0
    input.scenario.steps.forEach((step, stepIndex) => {
      if (step.kind !== 'observe') return
      if (checkpoints.has(step.checkpoint))
        ctx.addIssue({
          code: 'custom',
          path: ['scenario', 'steps', stepIndex, 'checkpoint'],
          message: '观测点名称不能重复。',
        })
      checkpoints.add(step.checkpoint)
      const names = new Set<string>()
      step.observations.forEach((observation, observationIndex) => {
        observationCount++
        if (names.has(observation.name))
          ctx.addIssue({
            code: 'custom',
            path: ['scenario', 'steps', stepIndex, 'observations', observationIndex, 'name'],
            message: '同一观测点中的名称不能重复。',
          })
        names.add(observation.name)
        observations.add(`${step.checkpoint}.${observation.name}`)
        if (observation.kind === 'canvas') {
          const region = [observation.x, observation.y, observation.width, observation.height]
          if (
            region.some((value) => value !== undefined) &&
            region.some((value) => value === undefined)
          )
            ctx.addIssue({
              code: 'custom',
              path: ['scenario', 'steps', stepIndex, 'observations', observationIndex],
              message: '画布区域必须同时提供 x、y、width 和 height。',
            })
        }
      })
    })
    if (observationCount > 64)
      ctx.addIssue({
        code: 'custom',
        path: ['scenario', 'steps'],
        message: '观测项不能超过 64 个。',
      })
    const assertionNames = new Set<string>()
    input.scenario.assertions.forEach((assertion, assertionIndex) => {
      const issue = (field: string, message: string) =>
        ctx.addIssue({
          code: 'custom',
          path: ['scenario', 'assertions', assertionIndex, field],
          message,
        })
      if (assertionNames.has(assertion.name)) issue('name', '断言名称不能重复。')
      assertionNames.add(assertion.name)
      const left = `${assertion.left.checkpoint}.${assertion.left.observation}`
      if (!observations.has(left)) issue('left', '断言引用了不存在的观测值。')
      const compares = [
        'changed',
        'unchanged',
        'greaterThan',
        'lessThan',
        'differenceAtLeast',
      ].includes(assertion.operator)
      if (compares && !assertion.compareTo) issue('compareTo', '这个断言需要另一个观测值。')
      if (!compares && assertion.compareTo) issue('compareTo', '这个断言不使用对比观测值。')
      if (
        ['equals', 'notEquals', 'contains'].includes(assertion.operator) &&
        assertion.expected === undefined
      )
        issue('expected', '这个断言需要明确的预期值。')
      if (assertion.expected !== undefined) {
        try {
          const encoded = JSON.stringify(assertion.expected)
          if (encoded === undefined || encoded.length > 5000)
            issue('expected', '预期值必须是小于 5 KB 的 JSON 值。')
        } catch {
          issue('expected', '预期值必须是可记录的 JSON 值。')
        }
      }
      if (assertion.operator === 'differenceAtLeast' && assertion.minimum === undefined)
        issue('minimum', '差值断言需要明确的最小差值。')
      if (assertion.operator !== 'differenceAtLeast' && assertion.minimum !== undefined)
        issue('minimum', '这个断言不使用最小差值。')
      if (assertion.compareTo) {
        const right = `${assertion.compareTo.checkpoint}.${assertion.compareTo.observation}`
        if (!observations.has(right)) issue('compareTo', '断言引用了不存在的对比观测值。')
        if (right === left) issue('compareTo', '不能把观测值与自身比较。')
      }
    })
  })

export type BehaviorVerifyInput = z.input<typeof behaviorVerifyInputSchema>
export type BehaviorStep = z.input<typeof stepSchema>
export type BehaviorObservation = z.input<typeof observationSchema>
export type BehaviorAssertion = z.input<typeof assertionSchema>

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export interface BehaviorObservationResult {
  checkpoint: string
  name: string
  kind: BehaviorObservation['kind']
  value: JsonValue
}
export interface BehaviorAssertionResult {
  name: string
  operator: BehaviorAssertion['operator']
  passed: boolean
  actual: JsonValue
  expected: JsonValue
}
export interface BehaviorVerifyResult {
  status: 'passed' | 'failed' | 'inconclusive'
  reason?: string
  browser?: string
  revision: number
  entry: { path: string; hash: string }
  loadedArtifacts: { path: string; hash: string }[]
  actions: { index: number; kind: BehaviorStep['kind']; outcome: 'done' }[]
  observations: BehaviorObservationResult[]
  assertions: BehaviorAssertionResult[]
  diagnostics: {
    consoleErrors: string[]
    pageErrors: string[]
    requestFailures: string[]
    blockedRequests: string[]
  }
}

// Chrome/Chromium is resolved per platform so the same build verifies on macOS, Linux and Windows.
// CHROME_PATH wins when set; packaged releases and containers use it to point at a bundled browser.
const chromeCandidates = (): string[] => {
  const configured = process.env.CHROME_PATH?.trim()
  if (configured) return [configured]
  if (process.platform === 'darwin')
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]
  if (process.platform === 'win32') {
    const roots = [
      process.env['PROGRAMFILES'],
      process.env['PROGRAMFILES(X86)'],
      process.env['LOCALAPPDATA'],
    ].filter((root): root is string => !!root)
    return roots.flatMap((root) => [
      `${root}\\Google\\Chrome\\Application\\chrome.exe`,
      `${root}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ])
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ]
}
const resolveChrome = () => chromeCandidates().find((candidate) => existsSync(candidate))
const mimeTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
}
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const abortError = () => Object.assign(new Error('行为检查已停止。'), { name: 'AbortError' })
const sanitize = (value: unknown, origin = '') =>
  String(value ?? '未知错误')
    .replaceAll(origin, '[local-origin]')
    .replace(/127\.0\.0\.1:\d+/g, '[local-origin]')
    .slice(0, 1000)

function deepEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function serverFor(workspace: Workspace, entryPath: string, loaded: Set<string>) {
  const server = createServer((request, response) => {
    if (!request.url || !['GET', 'HEAD'].includes(request.method ?? '')) {
      response.writeHead(405).end()
      return
    }
    try {
      const url = new URL(request.url, 'http://127.0.0.1')
      const decoded = decodeURIComponent(url.pathname)
      const relative = decoded === '/' ? entryPath : decoded.replace(/^\/+/, '')
      const target = workspace.resolve(relative)
      if (!existsSync(target) || !workspace.list().some((file) => file.path === relative)) {
        response.writeHead(404).end('Not found')
        return
      }
      loaded.add(relative)
      response.writeHead(200, {
        'Content-Type':
          mimeTypes[path.extname(relative).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; form-action 'none'; sandbox allow-scripts allow-forms",
        'X-Content-Type-Options': 'nosniff',
      })
      if (request.method === 'HEAD') response.end()
      else response.end(readFileSync(target))
    } catch {
      response.writeHead(400).end('Invalid path')
    }
  })
  return server
}

function listen(server: Server, signal: AbortSignal) {
  return new Promise<number>((resolve, reject) => {
    const abort = () => {
      server.close()
      reject(abortError())
    }
    signal.addEventListener('abort', abort, { once: true })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      signal.removeEventListener('abort', abort)
      const address = server.address()
      if (!address || typeof address === 'string') reject(new Error('无法建立本地检查页面。'))
      else resolve(address.port)
    })
  })
}

function closeServer(server?: Server) {
  if (!server?.listening) return Promise.resolve()
  return new Promise<void>((resolve) => server.close(() => resolve()))
}

async function one<T>(
  page: Page,
  css: string,
  work: (locator: ReturnType<Page['locator']>) => Promise<T>,
) {
  const locator = page.locator(css)
  const count = await locator.count()
  if (count !== 1) throw new Error(`选择器必须匹配一个元素，实际匹配 ${count} 个：${css}`)
  return work(locator)
}

async function observe(
  page: Page,
  observation: BehaviorObservation,
  diagnostics: BehaviorVerifyResult['diagnostics'],
): Promise<JsonValue> {
  switch (observation.kind) {
    case 'visible': {
      const locator = page.locator(observation.selector)
      const count = await locator.count()
      if (count > 1)
        throw new Error(`选择器必须至多匹配一个元素，实际匹配 ${count} 个：${observation.selector}`)
      return count === 1 && locator.isVisible()
    }
    case 'text':
      return one(page, observation.selector, async (locator) => (await locator.textContent()) ?? '')
    case 'count':
      return page.locator(observation.selector).count()
    case 'attribute':
      return one(page, observation.selector, (locator) =>
        locator.getAttribute(observation.attribute),
      )
    case 'computedStyle':
      return one(page, observation.selector, (locator) =>
        locator.evaluate(
          (element, property) => getComputedStyle(element).getPropertyValue(property),
          observation.property,
        ),
      )
    case 'boundingBox':
      return one(page, observation.selector, async (locator) => {
        const box = await locator.boundingBox()
        if (!box) throw new Error(`元素没有可观测的位置：${observation.selector}`)
        return box[observation.property]
      })
    case 'urlPath': {
      const url = new URL(page.url())
      return `${url.pathname}${url.search}${url.hash}`
    }
    case 'storageCount':
      return page.evaluate(
        (storage) => (storage === 'local' ? localStorage.length : sessionStorage.length),
        observation.storage,
      )
    case 'storageValue':
      return page.evaluate(
        ({ storage, key }) => (storage === 'local' ? localStorage : sessionStorage).getItem(key),
        { storage: observation.storage, key: observation.key },
      )
    case 'consoleErrorCount':
      return diagnostics.consoleErrors.length
    case 'pageErrorCount':
      return diagnostics.pageErrors.length
    case 'requestFailureCount':
      return diagnostics.requestFailures.length + diagnostics.blockedRequests.length
    case 'screenshotHash': {
      const image = observation.selector
        ? await one(page, observation.selector, (locator) =>
            locator.screenshot({ animations: 'disabled' }),
          )
        : await page.screenshot({ animations: 'disabled' })
      return digest(image)
    }
    case 'canvas': {
      const sample = await one(page, observation.selector, (locator) =>
        locator.evaluate((element, requested) => {
          if (!(element instanceof HTMLCanvasElement)) throw new Error('目标不是 canvas。')
          const x = requested.x ?? 0
          const y = requested.y ?? 0
          const width = requested.width ?? element.width
          const height = requested.height ?? element.height
          if (x + width > element.width || y + height > element.height)
            throw new Error('画布观测区域超出实际尺寸。')
          const sampleWidth = Math.min(128, width)
          const sampleHeight = Math.min(128, height)
          const copy = document.createElement('canvas')
          copy.width = sampleWidth
          copy.height = sampleHeight
          const context = copy.getContext('2d', { willReadFrequently: true })
          if (!context) throw new Error('无法读取 canvas 像素。')
          context.drawImage(element, x, y, width, height, 0, 0, sampleWidth, sampleHeight)
          return {
            sourceWidth: element.width,
            sourceHeight: element.height,
            region: { x, y, width, height },
            sampleWidth,
            sampleHeight,
            data: Array.from(context.getImageData(0, 0, sampleWidth, sampleHeight).data),
          }
        }, observation),
      )
      const pixels = Uint8Array.from(sample.data)
      if (observation.metric === 'hash') return digest(pixels)
      let visible = 0
      let luminance = 0
      const colors = new Set<number>()
      for (let index = 0; index < pixels.length; index += 4) {
        const [red, green, blue, alpha] = pixels.slice(index, index + 4)
        if (alpha) visible++
        luminance += (red * 299 + green * 587 + blue * 114) / 1000
        colors.add(((red << 24) | (green << 16) | (blue << 8) | alpha) >>> 0)
      }
      const count = pixels.length / 4
      if (observation.metric === 'nonTransparentRatio') return visible / count
      if (observation.metric === 'distinctColors') return colors.size
      return luminance / count
    }
    case 'globalValue': {
      // Only properties reachable from globalThis are supported. Top-level lexical let/const
      // bindings are deliberately inaccessible because this verifier never evaluates worker code.
      const value = await page.evaluate((parts) => {
        let current: unknown = globalThis
        for (const part of parts) {
          if ((typeof current !== 'object' && typeof current !== 'function') || current === null)
            throw new Error('全局只读路径不存在。')
          const descriptor = Object.getOwnPropertyDescriptor(current, part)
          if (!descriptor || !('value' in descriptor)) throw new Error('全局只读路径不存在。')
          current = descriptor.value
        }
        if (current !== null && !['string', 'number', 'boolean'].includes(typeof current))
          throw new Error('全局只读路径必须指向字符串、数字、布尔值或 null。')
        return current
      }, observation.path)
      const encoded = JSON.stringify(value)
      if (encoded === undefined || encoded.length > 10_000)
        throw new Error('全局只读观测值无法记录或超过 10 KB。')
      return JSON.parse(encoded) as JsonValue
    }
  }
}

function assertionResult(
  assertion: BehaviorAssertion,
  values: Map<string, JsonValue>,
): BehaviorAssertionResult {
  const actual = values.get(`${assertion.left.checkpoint}.${assertion.left.observation}`)!
  const comparison = assertion.compareTo
    ? values.get(`${assertion.compareTo.checkpoint}.${assertion.compareTo.observation}`)!
    : (assertion.expected as JsonValue)
  let passed = false
  if (assertion.operator === 'equals') passed = deepEqual(actual, comparison)
  else if (assertion.operator === 'notEquals') passed = !deepEqual(actual, comparison)
  else if (assertion.operator === 'contains')
    passed =
      (typeof actual === 'string' && actual.includes(String(comparison))) ||
      (Array.isArray(actual) && actual.some((entry) => deepEqual(entry, comparison)))
  else if (assertion.operator === 'changed') passed = !deepEqual(actual, comparison)
  else if (assertion.operator === 'unchanged') passed = deepEqual(actual, comparison)
  else if (assertion.operator === 'greaterThan')
    passed = typeof actual === 'number' && typeof comparison === 'number' && actual > comparison
  else if (assertion.operator === 'lessThan')
    passed = typeof actual === 'number' && typeof comparison === 'number' && actual < comparison
  else if (assertion.operator === 'differenceAtLeast')
    passed =
      typeof actual === 'number' &&
      typeof comparison === 'number' &&
      Math.abs(actual - comparison) >= assertion.minimum!
  return {
    name: assertion.name,
    operator: assertion.operator,
    passed,
    actual,
    expected: comparison,
  }
}

export async function verifyBehavior(
  workspace: Workspace,
  revision: number,
  rawInput: BehaviorVerifyInput,
  signal: AbortSignal,
): Promise<BehaviorVerifyResult> {
  const input = behaviorVerifyInputSchema.parse(rawInput)
  if (signal.aborted) throw abortError()
  const before = workspace.list()
  const entry = before.find((file) => file.path === input.path)
  if (!entry)
    return {
      status: 'inconclusive',
      reason: '入口文件不在当前产物清单中。',
      revision,
      entry: { path: input.path, hash: '' },
      loadedArtifacts: [],
      actions: [],
      observations: [],
      assertions: [],
      diagnostics: { consoleErrors: [], pageErrors: [], requestFailures: [], blockedRequests: [] },
    }
  const baseResult: BehaviorVerifyResult = {
    status: 'inconclusive',
    revision,
    entry: { path: entry.path, hash: entry.hash },
    loadedArtifacts: [],
    actions: [],
    observations: [],
    assertions: [],
    diagnostics: { consoleErrors: [], pageErrors: [], requestFailures: [], blockedRequests: [] },
  }
  const chromePath = resolveChrome()
  if (!chromePath)
    return { ...baseResult, reason: '本机没有可用的 Chrome／Chromium，可用 CHROME_PATH 指定。' }

  const loaded = new Set<string>()
  const server = serverFor(workspace, input.path, loaded)
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  let page: Page | undefined
  let origin = ''
  const abort = () => {
    void page?.close().catch(() => {})
    void context?.close().catch(() => {})
    void browser?.close().catch(() => {})
    server.close()
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    const port = await listen(server, signal)
    origin = `http://127.0.0.1:${port}`
    browser = await chromium.launch({
      executablePath: chromePath,
      headless: true,
      timeout: 10_000,
      args: [
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-sync',
        '--no-default-browser-check',
        // Containers and locked-down hosts pass their own flags (e.g. --no-sandbox) here.
        ...(process.env.CHROME_ARGS?.split(/\s+/).filter(Boolean) ?? []),
      ],
    })
    baseResult.browser = browser.version()
    context = await browser.newContext()
    page = await context.newPage()
    page.setDefaultTimeout(3000)
    page.setDefaultNavigationTimeout(5000)
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (url.origin === origin || ['data:', 'blob:', 'about:'].includes(url.protocol))
        await route.continue()
      else {
        baseResult.diagnostics.blockedRequests.push(sanitize(url.toString(), origin))
        await route.abort('blockedbyclient')
      }
    })
    page.on('console', (message) => {
      if (message.type() === 'error')
        baseResult.diagnostics.consoleErrors.push(sanitize(message.text(), origin))
    })
    page.on('pageerror', (error) =>
      baseResult.diagnostics.pageErrors.push(sanitize(error.message, origin)),
    )
    page.on('requestfailed', (request) => {
      if (!baseResult.diagnostics.blockedRequests.some((value) => request.url().includes(value)))
        baseResult.diagnostics.requestFailures.push(sanitize(request.url(), origin))
    })
    page.on('response', (response) => {
      if (response.status() >= 400)
        baseResult.diagnostics.requestFailures.push(
          `${response.status()} ${sanitize(response.url(), origin)}`,
        )
    })
    const encodedPath = input.path.split('/').map(encodeURIComponent).join('/')
    await page.goto(`${origin}/${encodedPath}`, { waitUntil: 'load' })

    const values = new Map<string, JsonValue>()
    for (const [index, step] of input.scenario.steps.entries()) {
      if (signal.aborted) throw abortError()
      if (step.kind === 'reload') await page.reload({ waitUntil: 'load' })
      else if (step.kind === 'click') await one(page, step.selector, (locator) => locator.click())
      else if (step.kind === 'fill')
        await one(page, step.selector, (locator) => locator.fill(step.value))
      else if (step.kind === 'key') {
        if (step.selector) await one(page, step.selector, (locator) => locator.focus())
        if (step.durationMs) {
          await page.keyboard.down(step.key)
          try {
            await page.waitForTimeout(step.durationMs)
          } finally {
            await page.keyboard.up(step.key).catch(() => {})
          }
        } else await page.keyboard.press(step.key)
      } else if (step.kind === 'wait') await page.waitForTimeout(step.ms)
      else {
        for (const observation of step.observations) {
          const value = await observe(page, observation, baseResult.diagnostics)
          values.set(`${step.checkpoint}.${observation.name}`, value)
          baseResult.observations.push({
            checkpoint: step.checkpoint,
            name: observation.name,
            kind: observation.kind,
            value,
          })
        }
      }
      baseResult.actions.push({ index, kind: step.kind, outcome: 'done' })
    }
    baseResult.assertions = input.scenario.assertions.map((assertion) =>
      assertionResult(assertion, values),
    )
    const after = workspace.list()
    if (JSON.stringify(before) !== JSON.stringify(after))
      return { ...baseResult, reason: '行为检查期间产物发生变化，证据已失效。' }
    const fileMap = new Map(before.map((file) => [file.path, file]))
    baseResult.loadedArtifacts = [...loaded]
      .map((file) => fileMap.get(file))
      .filter((file): file is NonNullable<typeof file> => !!file)
      .map((file) => ({ path: file.path, hash: file.hash }))
      .sort((left, right) => left.path.localeCompare(right.path))
    if (
      baseResult.diagnostics.blockedRequests.length ||
      baseResult.diagnostics.requestFailures.length ||
      baseResult.diagnostics.pageErrors.length ||
      baseResult.diagnostics.consoleErrors.length
    ) {
      baseResult.status = 'failed'
      baseResult.reason = '页面运行时出现错误或被阻止的请求。'
    } else
      baseResult.status = baseResult.assertions.every((assertion) => assertion.passed)
        ? 'passed'
        : 'failed'
    return baseResult
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError'))
      throw abortError()
    return { ...baseResult, status: 'inconclusive', reason: sanitize(error, origin) }
  } finally {
    signal.removeEventListener('abort', abort)
    await page?.close().catch(() => {})
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
    await closeServer(server)
  }
}
