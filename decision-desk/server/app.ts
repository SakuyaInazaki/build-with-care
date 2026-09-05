import express from 'express'
import path from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { RunState } from '../shared/types.js'
import { Manager } from './manager.js'
import { Workspace } from './workspace.js'
import { complete } from './models.js'
import { settingsPatchSchema } from './settings-store.js'
import { eventDetails } from './event-details.js'

const verdictSchema = z.object({
  requestId: z.string().uuid(),
  revision: z.number().int().positive(),
  decisionId: z.string().uuid(),
  gateId: z.string().uuid().optional(),
  action: z
    .enum(['correct', 'enforce', 'allow-once', 'acknowledge', 'rewrite', 'alternative', 'allow'])
    .transform((action) =>
      action === 'rewrite'
        ? ('enforce' as const)
        : action === 'alternative'
          ? ('correct' as const)
          : action === 'allow'
            ? ('allow-once' as const)
            : action,
    ),
  text: z.string().trim().max(2000).optional(),
  replaceConstraintId: z.string().uuid().optional(),
})
export function createApp(manager: Manager) {
  const app = express()
  let token = randomBytes(32).toString('hex'),
    tokenExpiresAt = Date.now() + 86400000
  const renewToken = () => {
    token = randomBytes(32).toString('hex')
    tokenExpiresAt = Date.now() + 86400000
  }
  app.disable('x-powered-by')
  app.use(express.json({ limit: '1mb' }))
  app.use(['/api', '/artifacts'], (req, res, next) => {
    const host = req.get('host') ?? ''
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
      res.status(403).json({ error: '只允许本地访问' })
      return
    }
    const origin = req.get('origin')
    if (origin && origin !== `http://${host}`) {
      res.status(403).json({ error: '请求来源不匹配' })
      return
    }
    res.setHeader('Cache-Control', 'no-store')
    if (req.path === '/bootstrap' && req.method === 'GET') {
      next()
      return
    }
    const candidate =
      req
        .get('cookie')
        ?.split(';')
        .map((c) => c.trim())
        .find((c) => c.startsWith('decision_session='))
        ?.slice('decision_session='.length) ?? ''
    if (
      Date.now() >= tokenExpiresAt ||
      !/^[a-f0-9]{64}$/.test(candidate) ||
      !timingSafeEqual(Buffer.from(candidate), Buffer.from(token))
    ) {
      res.status(401).json({ error: '会话已失效，请刷新页面' })
      return
    }
    next()
  })
  app.get('/api/bootstrap', (_req, res) => {
    if (Date.now() >= tokenExpiresAt) renewToken()
    res.cookie('decision_session', token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: Math.max(1, tokenExpiresAt - Date.now()),
    })
    res.json({
      settings: manager.publicSettings(),
      runs: manager.list(),
      backendVersion: 'unified-work-units-v4',
      capabilities: ['task-archive-v1', 'grill-batch-v1'],
      runtime: 'dsh 0.1.2-rc.1',
    })
  })
  app.get('/api/settings', (_req, res) => res.json(manager.publicSettings()))
  app.post('/api/settings', (req, res) => {
    const settings = settingsPatchSchema.parse(req.body)
    res.json(manager.updateSettings(settings))
  })
  app.post('/api/settings/test', async (req, res) => {
    const { role } = z.object({ role: z.enum(['worker', 'reviewer']) }).parse(req.body)
    const result = await complete(
      manager.settings[role],
      [{ role: 'user', content: '请只回复 OK' }],
      undefined,
      undefined,
      15000,
    )
    res.json({
      ok: !!result.content,
      message: result.content ? '连接成功，服务已返回响应。' : '服务没有返回文本，请检查接口。',
    })
  })
  app.get('/api/runs', (_req, res) => res.json(manager.list()))
  app.post('/api/runs', (req, res) => {
    const body = z
      .object({ prompt: z.string().trim().min(3).max(6000), mode: z.enum(['demo', 'live']) })
      .parse(req.body)
    res.status(201).json(manager.create(body.prompt, body.mode, body.mode === 'live'))
  })
  app.get('/api/runs/:id', (req, res) => res.json(manager.get(req.params.id)))
  app.post('/api/runs/:id/archive', (req, res) => {
    const input = z.object({ requestId: z.string().uuid(), archive: z.boolean() }).parse(req.body)
    res.json(manager.archive(req.params.id, input))
  })
  app.post('/api/runs/:id/verify', (req, res) => {
    const input = z
      .object({ requestId: z.string().uuid(), revision: z.number().int().positive() })
      .parse(req.body)
    res.json(manager.verifyArtifacts(req.params.id, input))
  })
  app.post('/api/runs/:id/grill', async (req, res) => {
    const input = z
      .object({
        round: z.number().int().min(0).max(6),
        answer: z.string().trim().min(1).max(12100).optional(),
        choices: z.array(z.string().min(1).max(2000)).max(4).optional(),
        answers: z
          .array(
            z.object({
              questionId: z.string().uuid().optional(),
              question: z.string().trim().min(1).max(2000).optional(),
              choices: z.array(z.string().min(1).max(2000)).max(4).optional(),
              answer: z.string().max(4000).optional(),
            }),
          )
          .max(3)
          .optional(),
      })
      .parse(req.body)
    res.json(await manager.advanceGrill(req.params.id, input))
  })
  app.delete('/api/runs/:id', async (req, res) => {
    await manager.delete(req.params.id)
    res.json({ deleted: true })
  })
  app.post('/api/runs/:id/start', async (req, res) => {
    const { constraints, confirmation } = z
      .object({
        constraints: z.array(z.string().trim().min(1).max(2000)).min(1).max(24),
        confirmation: z
          .object({
            confirmed: z.boolean(),
            acceptedAssumptions: z.boolean(),
            unresolved: z
              .array(z.object({ item: z.string().max(2000), answer: z.string().max(2000) }))
              .max(8),
          })
          .optional(),
      })
      .parse(req.body)
    res.json(await manager.start(req.params.id, constraints, undefined, confirmation))
  })
  app.post('/api/runs/:id/resume', async (req, res) => {
    const input = z
      .object({ requestId: z.string().uuid(), revision: z.number().int().positive() })
      .parse(req.body)
    res.json(await manager.resume(req.params.id, input))
  })
  app.post('/api/runs/:id/retry-review', (req, res) => {
    const input = z
      .object({
        requestId: z.string().uuid(),
        revision: z.number().int().positive(),
        stepId: z.string().uuid(),
      })
      .parse(req.body)
    res.json(manager.runtime(req.params.id).retryReview(input, manager.settings))
  })
  app.post('/api/runs/:id/verdict', (req, res) =>
    res.json(manager.runtime(req.params.id).verdict(verdictSchema.parse(req.body))),
  )
  app.post('/api/runs/:id/additions', async (req, res) => {
    const input = z
      .object({
        requestId: z.string().uuid(),
        revision: z.number().int().positive(),
        kind: z.enum(['requirement', 'idea']),
        text: z.string().trim().min(1).max(3000),
        replaceConstraintId: z.string().uuid().optional(),
      })
      .parse(req.body)
    res.json(await manager.addInput(req.params.id, input))
  })
  app.post('/api/runs/:id/stop', (req, res) => {
    const { requestId } = z.object({ requestId: z.string().uuid() }).parse(req.body)
    manager.runtime(req.params.id).requestStop(undefined, true, requestId)
    res.json(manager.get(req.params.id))
  })
  app.post('/api/runs/:id/reflection', (req, res) => {
    const { reflection } = z.object({ reflection: z.string().max(3000) }).parse(req.body)
    res.json(manager.updateReflection(req.params.id, reflection))
  })
  app.get('/api/runs/:id/summary', (req, res) => res.json(manager.summary(req.params.id)))
  app.get('/api/runs/:id/units', (req, res) => res.json(manager.get(req.params.id).workUnits ?? []))
  app.get('/api/runs/:id/events', (req, res) =>
    res.json(
      manager.store.events(
        manager.get(req.params.id).id,
        Math.max(0, Number(req.query.after) || 0),
      ),
    ),
  )
  app.get('/api/runs/:id/stream', (req, res) => {
    const state = manager.get(req.params.id)
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders()
    let closed = false,
      blocked = false,
      pendingState: RunState | undefined
    const flush = () => {
      blocked = false
      if (!closed && pendingState) {
        const latest = pendingState
        pendingState = undefined
        send(latest)
      }
    }
    const write = (value: string) => {
      if (closed || blocked) return false
      if (!res.write(value)) {
        blocked = true
        res.once('drain', flush)
      }
      return !blocked
    }
    const send = (s: RunState) => {
      if (s.id !== state.id || closed) return
      if (blocked) {
        pendingState = s
        return
      }
      write(`id: ${s.lastEventSeq}\nevent: state\ndata: ${JSON.stringify(s)}\n\n`)
    }
    send(state)
    manager.events.on('state', send)
    const heartbeat = setInterval(() => write(': heartbeat\n\n'), 15000)
    const expiry = setTimeout(() => res.end(), Math.max(1, tokenExpiresAt - Date.now()))
    expiry.unref()
    req.on('close', () => {
      closed = true
      pendingState = undefined
      clearInterval(heartbeat)
      clearTimeout(expiry)
      manager.events.off('state', send)
      res.off('drain', flush)
    })
  })
  app.get('/api/runs/:id/events/:seq/details', (req, res) => {
    const detail = eventDetails(manager.store, manager.get(req.params.id), Number(req.params.seq))
    if (!detail) {
      res.status(404).json({ error: '记录不存在' })
      return
    }
    res.json(detail)
  })
  app.get('/api/runs/:id/export', (req, res) => {
    const state = manager.get(req.params.id)
    res.setHeader('Content-Disposition', `attachment; filename="decision-record-${state.id}.json"`)
    res.json({
      version: 1,
      exportedAt: new Date().toISOString(),
      state,
      summary: manager.summary(state.id),
      events: manager.store.events(state.id),
    })
  })
  app.get('/artifacts/:id/{*file}', (req, res) => {
    const state = manager.get(String(req.params.id)),
      file = Array.isArray(req.params.file) ? req.params.file.join('/') : String(req.params.file)
    if (!state.files.some((f) => f.path === file)) {
      res.status(404).send('文件尚未生成')
      return
    }
    const workspace = new Workspace(path.join(manager.store.directory(state.id), 'workspace'))
    res.set({
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; form-action 'none'; sandbox allow-scripts allow-forms",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    })
    res.type(path.extname(file))
    res.send(workspace.read(file))
  })
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }))
  return app
}
export const errorHandler: express.ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof z.ZodError) {
    res.status(400).json({
      error: '输入格式不正确，请检查字段内容',
      details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    })
    return
  }
  res
    .status(error.status ?? 400)
    .json({ error: error instanceof Error ? error.message : '请求未完成' })
}
