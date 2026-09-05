import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
  rmSync,
} from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AppEvent, RunState } from '../shared/types.js'
import { cancelUnits } from './work-units.js'

const credentialFields = new Set([
  'apikey',
  'authorization',
  'password',
  'passwd',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'clientsecret',
  'privatekey',
  'cookie',
  'setcookie',
  'token',
])

export class Store {
  readonly root: string
  private credentialValues = new Set<string>()
  constructor(root: string) {
    this.root = path.resolve(root)
    mkdirSync(this.root, { recursive: true })
  }
  directory(id: string) {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('无效的任务标识')
    const dir = path.join(this.root, id)
    mkdirSync(dir, { recursive: true })
    return dir
  }
  setCredentialValues(values: (string | undefined)[]) {
    this.credentialValues = new Set(
      values
        .filter((value): value is string => !!value && value.length >= 8)
        .sort((a, b) => b.length - a.length),
    )
  }
  private redact(value: unknown, operational = false): unknown {
    if (typeof value === 'string') {
      if (operational) return value
      let result = value
      for (const credential of this.credentialValues)
        result = result.replaceAll(credential, '[REDACTED]')
      return result
    }
    if (Array.isArray(value)) return value.map((entry) => this.redact(entry, operational))
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
        const normalized = key.toLowerCase().replace(/[^a-z]/g, '')
        const isOperational =
          operational || ['args', 'arguments', 'argumentsdelta'].includes(normalized)
        const credentialField = credentialFields.has(normalized)
        return [
          key,
          credentialField && !isOperational ? '[REDACTED]' : this.redact(entry, isOperational),
        ]
      }),
    )
  }
  append(state: RunState, type: string, data: unknown): AppEvent {
    const event: AppEvent = {
      id: randomUUID(),
      seq: state.lastEventSeq + 1,
      runId: state.id,
      type,
      at: new Date().toISOString(),
      data: this.redact(data),
    }
    // A verdict reaches durable storage before its pending tool can be released.
    const fd = openSync(path.join(this.directory(state.id), 'events.jsonl'), 'a', 0o600)
    try {
      fchmodSync(fd, 0o600)
      writeFileSync(fd, JSON.stringify(event) + '\n')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    state.lastEventSeq = event.seq
    state.updatedAt = event.at
    return event
  }
  save(state: RunState) {
    const dir = this.directory(state.id),
      tmp = path.join(dir, 'state.tmp')
    const fd = openSync(tmp, 'w', 0o600)
    try {
      fchmodSync(fd, 0o600)
      writeFileSync(fd, JSON.stringify(this.redact(state), null, 2), 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path.join(dir, 'state.json'))
  }
  recordRaw(id: string, event: unknown) {
    const fd = openSync(path.join(this.directory(id), 'dsh-events.jsonl'), 'a', 0o600)
    try {
      fchmodSync(fd, 0o600)
      writeFileSync(fd, JSON.stringify(this.redact(event)) + '\n')
    } finally {
      closeSync(fd)
    }
  }
  rawEvents(id: string): { type: string; seq: number; time: number; data: any }[] {
    const file = path.join(this.directory(id), 'dsh-events.jsonl')
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  }
  delete(id: string) {
    const directory = this.directory(id)
    // Kept outside the run directory so deleting that run cannot erase its audit.
    const audit = path.join(
      path.dirname(this.root),
      `${path.basename(this.root)}.deletion-audit.jsonl`,
    )
    const operationId = randomUUID()
    const appendAudit = (phase: string) => {
      const fd = openSync(audit, 'a')
      try {
        fchmodSync(fd, 0o600)
        writeFileSync(
          fd,
          JSON.stringify({ operationId, runId: id, at: new Date().toISOString(), phase }) + '\n',
        )
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    }
    appendAudit('requested')
    rmSync(directory, { recursive: true, force: false })
    appendAudit('completed')
  }
  loadAll(): RunState[] {
    return readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => {
        const file = path.join(this.root, d.name, 'state.json')
        if (!existsSync(file)) return []
        try {
          const state = JSON.parse(readFileSync(file, 'utf8')) as RunState
          // A power loss can leave the last fsynced human decision ahead of the UI snapshot.
          const tail = this.events(state.id, state.lastEventSeq)
          for (const event of tail) {
            const data = event.data as any
            if (event.type === 'human.intervention' && data.intervention) {
              if (!state.interventions.some((i) => i.id === data.intervention.id))
                state.interventions.push(data.intervention)
              if (data.constraints) state.constraints = data.constraints
              state.revision = Math.max(state.revision, data.intervention.toRevision)
              const decision = state.decisions.find((d) => d.id === data.intervention.decisionId)
              if (decision)
                decision.humanStatus =
                  data.intervention.action === 'acknowledge'
                    ? 'acknowledged'
                    : data.intervention.action === 'allow-once'
                      ? 'allowed-once'
                      : 'corrected'
            }
            if (event.type === 'human.reflection') state.reflection = data.reflection
            state.lastEventSeq = Math.max(state.lastEventSeq, event.seq)
          }
          if (tail.length) this.save(state)
          if (['running', 'waiting', 'stopping'].includes(state.status)) {
            cancelUnits(state)
            state.modelProgress = undefined
            state.reviewFailure = undefined
            state.status = 'interrupted'
            state.error = '服务已中断，可点击“继续任务”继续。'
            for (const gate of state.gates) if (gate.status === 'pending') gate.status = 'cancelled'
            for (const step of state.steps)
              if (['reviewing', 'waiting', 'executing'].includes(step.status))
                step.status = 'cancelled'
            for (const decision of state.decisions)
              if (['reviewing', 'waiting', 'executing'].includes(decision.executionStatus))
                decision.executionStatus = 'cancelled'
            this.append(state, 'run.interrupted', { reason: state.error })
            this.save(state)
          }
          return [state]
        } catch {
          return []
        }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  events(id: string, after = 0): AppEvent[] {
    const file = path.join(this.directory(id), 'events.jsonl')
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const e = JSON.parse(line) as AppEvent
          return e.seq > after ? [e] : []
        } catch {
          return []
        }
      })
  }
}
