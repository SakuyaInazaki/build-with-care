import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import express from 'express'
import { createApp, errorHandler } from './app.js'
import { Manager } from './manager.js'
import { demoBanner, publicDemoEnabled, publicDemoGuard, startDemoJanitor } from './public-demo.js'

if (existsSync('.env')) process.loadEnvFile('.env')
const manager = new Manager(path.resolve(process.env.DATA_DIR ?? '.data/runs'))
const app = createApp(manager, publicDemoEnabled ? publicDemoGuard() : undefined),
  production = process.argv.includes('--production')
if (publicDemoEnabled) startDemoJanitor(manager)
let closeVite: (() => Promise<void>) | undefined
if (production) {
  const frontend = path.resolve(process.env.FRONTEND_DIST ?? 'dist')
  if (!existsSync(path.join(frontend, 'index.html'))) throw new Error('请先构建前端')
  // 离线包下载目录（可选）。必须在 SPA 兜底之前注册，否则会被前端路由吃掉。
  const downloads = process.env.DOWNLOAD_DIR
  if (downloads && existsSync(downloads))
    app.use(
      '/downloads',
      express.static(downloads, {
        index: 'index.html',
        setHeaders: (res, file) => {
          if (file.endsWith('.zip')) res.setHeader('Content-Disposition', 'attachment')
        },
      }),
    )
  // The shared deployment serves its own shell so the notice cannot be bypassed via the static index.
  app.use(express.static(frontend, publicDemoEnabled ? { index: false } : {}))
  const shell = readFileSync(path.join(frontend, 'index.html'), 'utf8')
  const page = publicDemoEnabled ? demoBanner(shell) : shell
  app.get('/{*path}', (_req, res) => res.type('html').send(page))
} else {
  const { createServer: createViteServer } = await import('vite')
  const vite = await createViteServer({
    root: process.env.FRONTEND_ROOT ? path.resolve(process.env.FRONTEND_ROOT) : undefined,
    server: { middlewareMode: true },
    appType: 'spa',
  })
  app.use(vite.middlewares)
  closeVite = () => vite.close()
}
app.use(errorHandler)
const server = createServer(app),
  port = Number(process.env.PORT ?? 4317),
  // Loopback stays the default; a deployment opts into a reachable interface explicitly.
  host = process.env.HOST ?? '127.0.0.1'
server.listen(port, host, () =>
  console.log(`看着办 · 工作空间 http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`),
)
let closing = false
async function shutdown() {
  if (closing) return
  closing = true
  await manager.dispose()
  await closeVite?.()
  server.close()
  server.closeAllConnections()
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
