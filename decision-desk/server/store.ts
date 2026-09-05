import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
} from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AppEvent, RunState } from '../shared/types.js'

export class Store {
  readonly root: string
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
  append(state: RunState, type: string, data: unknown): AppEvent {
    const event: AppEvent = {
      id: randomUUID(),
      seq: state.lastEventSeq + 1,
      runId: state.id,
      type,
      at: new Date().toISOString(),
      data,
    }
    // A verdict reaches durable storage before its pending tool can be released.
    const fd = openSync(path.join(this.directory(state.id), 'events.jsonl'), 'a')
    try {
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
    const fd = openSync(tmp, 'w')
    try {
      writeFileSync(fd, JSON.stringify(state, null, 2), 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path.join(dir, 'state.json'))
  }
  recordRaw(id: string, event: unknown) {
    appendFileSync(path.join(this.directory(id), 'dsh-events.jsonl'), JSON.stringify(event) + '\n')
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
            state.status = 'interrupted'
            state.error =
              '服务重启，中断的工具不会自动重新执行。可查看原记录，再通过追加要求明确继续。'
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
