#!/usr/bin/env node
/** Link packages from one explicit dsh checkout into this repository. This script
 * never reads or writes ~/.dsh and never links an external node_modules directory. */
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const clone = process.env.DSH_CLONE
if (!clone) {
  console.error('link-dsh: DSH_CLONE must name an explicit DeepSeek Harness checkout; ~/.dsh is never inspected')
  process.exit(1)
}
const rootManifest = JSON.parse(readFileSync(join(clone, 'package.json'), 'utf8'))
if (rootManifest.name !== '@deepseek-ai/dsh-root' || rootManifest.version !== '0.1.3-alpha.1') {
  console.error(`link-dsh: expected @deepseek-ai/dsh-root 0.1.3-alpha.1 at DSH_CLONE, got ${rootManifest.name ?? '<unknown>'} ${rootManifest.version ?? '<unknown>'}`)
  process.exit(1)
}
let commit
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: clone, encoding: 'utf8' }).trim()
} catch {
  console.error(`link-dsh: cannot read git HEAD from DSH_CLONE ${clone}`)
  process.exit(1)
}
if (commit !== 'd347e703908d0406b7a7ef80e3a0e594d86b2215') {
  console.error(`link-dsh: expected dsh commit d347e70390, got ${commit.slice(0, 10)}`)
  process.exit(1)
}
const candidates = [join(clone, 'packages'), join(clone, 'vendor')]
const packageEntries = []
for (const root of candidates) {
  if (!existsSync(root)) continue
  for (const group of readdirSync(root, { withFileTypes: true })) {
    const groupRoot = join(root, group.name)
    const children = group.isDirectory() && root.endsWith('/packages') ? readdirSync(groupRoot, { withFileTypes: true }).map((entry) => join(groupRoot, entry.name)) : [groupRoot]
    for (const sourcePath of children) {
      try {
        const source = realpathSync(sourcePath)
        const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
        if (typeof manifest.name === 'string' && manifest.name.startsWith('@deepseek-ai/')) packageEntries.push({ name: manifest.name.slice('@deepseek-ai/'.length), source })
      } catch { /* skip non-package directories and broken external links */ }
    }
  }
}
if (packageEntries.length === 0) {
  console.error(`link-dsh: no dsh packages found in ${clone}`)
  process.exit(1)
}

const scope = join(pkgRoot, 'node_modules', '@deepseek-ai')
mkdirSync(scope, { recursive: true })
for (const { name, source } of packageEntries) {
  const destination = join(scope, name)
  if (!existsSync(join(source, 'package.json'))) continue
  let same = false
  try { same = lstatSync(destination).isSymbolicLink() && resolve(scope, readlinkSync(destination)) === resolve(source) } catch { /* absent */ }
  if (same) continue
  rmSync(destination, { recursive: true, force: true })
  symlinkSync(source, destination, 'dir')
}
console.log(`link-dsh: linked ${packageEntries.length} packages from dsh 0.1.3-alpha.1 into repository-local node_modules`)
