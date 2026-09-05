import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { parseHTML } from 'linkedom'
import { parse } from 'acorn'

export const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export class Workspace {
  readonly root: string
  constructor(root: string) {
    mkdirSync(root, { recursive: true })
    this.root = realpathSync(root)
  }
  resolve(relative: string) {
    if (
      !relative ||
      relative.includes('\0') ||
      relative.includes(':') ||
      relative.includes('\\') ||
      path.isAbsolute(relative)
    )
      throw new Error('请使用项目内的相对路径')
    if (
      relative
        .split('/')
        .some(
          (part) =>
            !part ||
            /[. ]$/.test(part) ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        )
    )
      throw new Error('路径中含不支持的文件名')
    const target = path.resolve(this.root, relative),
      rel = path.relative(this.root, target)
    if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))
      throw new Error('路径超出了本任务工作区')
    let current = this.root
    for (const part of rel.split(path.sep)) {
      current = path.join(current, part)
      if (existsSync(current) && lstatSync(current).isSymbolicLink())
        throw new Error('工作区不支持符号链接')
    }
    return target
  }
  read(relative: string) {
    return readFileSync(this.resolve(relative), 'utf8')
  }
  previewEdit(relative: string, oldText: string, newText: string) {
    const original = this.read(relative)
    if (!oldText) throw new Error('oldText 不能为空。请先 read_file，再提供唯一的精确匹配文本。')
    const matches = original.split(oldText).length - 1
    if (matches !== 1)
      throw new Error(
        `edit_file 未执行：oldText 在 ${relative} 中匹配 ${matches} 次，必须恰好匹配 1 次。请先 read_file 读取最新内容，再用包含足够上下文的原文重新提交 edit_file；不要重复原参数。`,
      )
    return original.replace(oldText, () => newText)
  }
  write(relative: string, content: string) {
    if (!/\.(html|css|js|json|md|txt)$/.test(relative))
      throw new Error('首版只支持 HTML、CSS、JS、JSON、Markdown 与文本文件')
    if (Buffer.byteLength(content) > 250_000) throw new Error('单个文件不能超过 250 KB，请拆分文件')
    const target = this.resolve(relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
    return { path: relative, hash: hash(content), bytes: Buffer.byteLength(content) }
  }
  list(): { path: string; hash: string; bytes: number }[] {
    const walk = (dir: string): { path: string; hash: string; bytes: number }[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.isSymbolicLink()) return []
        const p = path.join(dir, entry.name)
        if (entry.isDirectory()) return walk(p)
        const content = readFileSync(p, 'utf8')
        return [
          {
            path: path.relative(this.root, p).split(path.sep).join('/'),
            hash: hash(content),
            bytes: Buffer.byteLength(content),
          },
        ]
      })
    return walk(this.root)
  }
}

export function inspectHtml(content: string) {
  const { document } = parseHTML(content)
  const scripts = [...document.querySelectorAll('script')].filter(
    (s) => !s.type || ['text/javascript', 'module', 'application/javascript'].includes(s.type),
  )
  let validJavaScript = true,
    persistence = false
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    if (
      n.type === 'Identifier' &&
      ['localStorage', 'sessionStorage', 'indexedDB'].includes(String(n.name))
    )
      persistence = true
    if (n.type === 'MemberExpression') {
      const prop = n.property as Record<string, unknown> | undefined
      if (
        prop &&
        ['localStorage', 'sessionStorage', 'indexedDB'].includes(String(prop.name ?? prop.value))
      )
        persistence = true
    }
    Object.values(n).forEach((v) => {
      if (Array.isArray(v)) v.forEach(walk)
      else if (typeof v === 'object') walk(v)
    })
  }
  for (const script of scripts) {
    try {
      walk(
        parse(script.textContent ?? '', {
          ecmaVersion: 'latest',
          sourceType: script.type === 'module' ? 'module' : 'script',
        }),
      )
    } catch {
      validJavaScript = false
    }
  }
  const externalResources = [...document.querySelectorAll('[src],link[href]')].some((n) =>
    /^(https?:)?\/\//i.test(n.getAttribute('src') ?? n.getAttribute('href') ?? ''),
  )
  const visibleLogin = [...document.querySelectorAll('input')].some(
    (n) => n.getAttribute('type') === 'password',
  )
  return {
    structure:
      !!document.querySelector('html') &&
      !!document.querySelector('title') &&
      !!document.querySelector('body'),
    validJavaScript,
    persistence,
    externalResources,
    visibleLogin,
    // This is deliberately a static check, not a proof about all runtime behavior.
  }
}
