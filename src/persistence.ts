import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { EventPersistence, TimelineEvent } from './types.js'

export interface PersistenceRecovery {
  events: TimelineEvent[]
  ignoredTrailingBytes: boolean
}

/** Synchronous writes keep the event and its derived in-memory state ordered. */
export class JsonlEventPersistence implements EventPersistence {
  readonly filePath: string
  readonly recovery: PersistenceRecovery

  constructor(filePath: string) {
    this.filePath = filePath
    mkdirSync(dirname(filePath), { recursive: true })
    this.recovery = readJsonl(filePath)
  }

  append(event: TimelineEvent): void {
    appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, 'utf8')
  }

  load(): TimelineEvent[] { return readJsonl(this.filePath).events.map((event) => structuredClone(event)) }
}

function readJsonl(filePath: string): PersistenceRecovery {
  let text: string
  try { text = readFileSync(filePath, 'utf8') } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], ignoredTrailingBytes: false }
    throw error
  }
  if (!text) return { events: [], ignoredTrailingBytes: false }
  const lines = text.split('\n')
  const hasTrailingNewline = text.endsWith('\n')
  if (hasTrailingNewline) lines.pop()
  const events: TimelineEvent[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    try {
      const value: unknown = JSON.parse(line)
      if (!value || typeof value !== 'object' || !('sessionId' in value) || !('type' in value)) throw new Error('not a timeline event')
      events.push(value as TimelineEvent)
    } catch (error) {
      const isLastPartialLine = index === lines.length - 1 && !hasTrailingNewline
      if (isLastPartialLine) return { events, ignoredTrailingBytes: true }
      throw new Error(`invalid JSONL event at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { events, ignoredTrailingBytes: false }
}
