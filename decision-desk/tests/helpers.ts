import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Manager, defaultSettings } from '../server/manager.js'
import type { Settings } from '../shared/types.js'

export function fixture(overrides: Partial<Settings> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'decision-desk-test-'))
  const manager = new Manager(dir, {
    ...defaultSettings(),
    demoDelayMs: 10,
    reviewTimeoutMs: 2000,
    ...overrides,
  })
  return {
    manager,
    dir,
    async cleanup() {
      await manager.dispose()
      const resolved = path.resolve(dir)
      if (
        path.dirname(resolved) !== path.resolve(tmpdir()) ||
        !path.basename(resolved).startsWith('decision-desk-test-')
      )
        throw new Error('拒绝清理非测试目录')
      rmSync(resolved, { recursive: true, force: true })
    },
  }
}
export async function until(predicate: () => boolean, timeoutMs = 10000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待测试条件超时')
    await delay(15)
  }
}
