import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Settings } from '../shared/types.js'

const modelSchema = z.object({
  baseUrl: z.string().min(1).max(500),
  model: z.string().trim().min(1).max(100),
  family: z.string().trim().min(1).max(60),
  apiKey: z.string().max(2000),
  reasoningEffort: z.enum(['none', 'low', 'high', 'max']).optional(),
})
export const settingsPatchSchema = z.object({
  worker: modelSchema,
  reviewer: modelSchema,
  reviewTimeoutMs: z.number().int().min(2000).max(60000),
  gateTimeoutMs: z.number().int().min(1000).max(3600000).optional(),
})
const storedSettingsSchema = settingsPatchSchema.extend({
  version: z.literal(1),
  gateTimeoutMs: z.number().int().min(1000).max(3600000),
})

export class SettingsStore {
  readonly file: string
  constructor(root: string) {
    this.file = path.join(root, '.settings.json')
  }
  load(defaults: Settings): Settings {
    if (!existsSync(this.file)) return defaults
    try {
      const { version: _version, ...saved } = storedSettingsSchema.parse(
        JSON.parse(readFileSync(this.file, 'utf8')),
      )
      return { ...defaults, ...saved }
    } catch {
      throw new Error('无法读取已保存的模型配置，原配置文件已保留。')
    }
  }
  save(settings: Settings) {
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      const saved = storedSettingsSchema.parse({ ...settings, version: 1 })
      const fd = openSync(temporary, 'wx', 0o600)
      try {
        writeFileSync(fd, JSON.stringify(saved), 'utf8')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temporary, this.file)
    } catch {
      throw new Error('模型配置未能保存到本机，原配置保持不变。')
    } finally {
      rmSync(temporary, { force: true })
    }
  }
}
