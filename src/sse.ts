import type { IncomingMessage, ServerResponse } from 'node:http'

export interface SseOptions { pingMs?: number }

/**
 * One Server-Sent-Events connection. Writes are bounded and paused while the socket applies backpressure.
 */
export class SseConnection {
  private closed = false
  private readonly closeListeners = new Set<() => void>()
  private readonly ping: ReturnType<typeof setInterval>
  private readonly queue: string[] = []
  private queuedBytes = 0
  private writing = false
  private static readonly MAX_QUEUE = 64
  private static readonly MAX_BYTES = 256 * 1024

  constructor(request: IncomingMessage, private readonly response: ServerResponse, options: SseOptions = {}) {
    response.statusCode = 200
    response.setHeader('content-type', 'text/event-stream; charset=utf-8')
    response.setHeader('cache-control', 'no-cache, no-transform')
    response.setHeader('connection', 'keep-alive')
    response.setHeader('x-accel-buffering', 'no')
    response.flushHeaders()
    response.write(': connected\n\n')
    this.ping = setInterval(() => this.send('ping', { at: new Date().toISOString() }), options.pingMs ?? 15_000)
    const close = () => this.close()
    request.on('close', close)
    response.on('close', close)
    response.on('error', close)
  }

  get isOpen(): boolean { return !this.closed }

  send(event: string, data: unknown): void {
    if (this.closed || this.response.destroyed || !this.response.writable) return
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    try {
      if (this.writing || this.queue.length) {
        if (this.queue.length >= SseConnection.MAX_QUEUE || this.queuedBytes + Buffer.byteLength(frame) > SseConnection.MAX_BYTES) {
          this.close()
          return
        }
        this.queue.push(frame)
        this.queuedBytes += Buffer.byteLength(frame)
        return
      }
      this.writing = true
      const drained = this.response.write(frame)
      if (drained) this.writing = false
      else this.response.once('drain', () => this.flush())
    } catch {
      this.close()
    }
  }

  private flush(): void {
    if (this.closed) return
    this.writing = false
    while (this.queue.length) {
      const frame = this.queue.shift()!
      this.queuedBytes -= Buffer.byteLength(frame)
      this.writing = true
      try {
        if (!this.response.write(frame)) { this.response.once('drain', () => this.flush()); return }
      } catch { this.close(); return }
      this.writing = false
    }
  }

  onClose(listener: () => void): void {
    if (this.closed) listener()
    else this.closeListeners.add(listener)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.ping)
    this.queue.length = 0
    this.queuedBytes = 0
    for (const listener of this.closeListeners) {
      try { listener() } catch { /* cleanup must not throw */ }
    }
    this.closeListeners.clear()
    if (!this.response.destroyed) this.response.end()
  }
}

/** Minimal SSE frame parser for tests and CLI clients: yields `{ event, data }` per frame. */
export function parseSseFrames(chunk: string): Array<{ event: string; data: string }> {
  const frames: Array<{ event: string; data: string }> = []
  for (const block of chunk.split('\n\n')) {
    let event = 'message'
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trim())
    }
    if (data.length) frames.push({ event, data: data.join('\n') })
  }
  return frames
}
