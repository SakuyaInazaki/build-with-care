import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import express from 'express'
import { createApp, errorHandler } from './app.js'
import { Manager } from './manager.js'

if (existsSync('.env')) process.loadEnvFile('.env')
const manager = new Manager(path.resolve(process.env.DATA_DIR ?? '.data/runs'))
const app = createApp(manager),
  production = process.argv.includes('--production')
let closeVite: (() => Promise<void>) | undefined
if (production) {
  if (!existsSync('dist/index.html')) throw new Error('请先运行 pnpm build')
  app.use(express.static(path.resolve('dist')))
  app.get('/{*path}', (_req, res) => res.type('html').send(readFileSync('dist/index.html', 'utf8')))
} else {
  const { createServer: createViteServer } = await import('vite')
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' })
  app.use(vite.middlewares)
  closeVite = () => vite.close()
}
app.use(errorHandler)
const server = createServer(app),
  port = Number(process.env.PORT ?? 4317)
server.listen(port, '127.0.0.1', () => console.log(`在场 · 决策对账台 http://127.0.0.1:${port}`))
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
