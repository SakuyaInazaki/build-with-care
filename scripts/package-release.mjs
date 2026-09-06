#!/usr/bin/env node
// 打出自带 Node 运行时的免安装压缩包：解压后双击启动脚本即可运行。
// 目标机器不需要装 Node，不需要装 Docker，不需要联网下载任何东西。
//
//   node scripts/package-release.mjs                     # 全部平台
//   node scripts/package-release.mjs --targets=windows-x64,macos-arm64
//   node scripts/package-release.mjs --no-runtime        # 只打不含运行时的通用包
//
// 产物在 release/ 下。服务端 TypeScript 先编译成 JavaScript，运行时不需要 tsx，
// 也就不依赖 esbuild 的平台原生二进制；应用代码本身三平台通用，只有 Node 运行时按平台分发。
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const release = path.join(root, 'release')
const version = JSON.parse(readFileSync(path.join(root, 'frontend/package.json'), 'utf8')).version
const app = path.join(release, '.app')
const cache = path.join(release, '.node-cache')

// 与 decision-desk 的 engines 一致。固定版本，保证每次打出来的包完全一样。
const NODE_VERSION = 'v24.20.0'
const MIRROR = process.env.NODE_MIRROR ?? 'https://cdn.npmmirror.com/binaries/node'

const TARGETS = [
  { key: 'macos-arm64', dist: 'darwin-arm64', kind: 'tar' },
  { key: 'macos-intel', dist: 'darwin-x64', kind: 'tar' },
  { key: 'windows-x64', dist: 'win-x64', kind: 'zip' },
  { key: 'linux-x64', dist: 'linux-x64', kind: 'tar' },
]

const argv = process.argv.slice(2)
const withRuntime = !argv.includes('--no-runtime')
const selected = argv.find((a) => a.startsWith('--targets='))?.slice('--targets='.length)
const targets = selected
  ? TARGETS.filter((t) => selected.split(',').includes(t.key))
  : withRuntime
    ? TARGETS
    : []

const run = (command, cmdArgs, cwd = root) =>
  execFileSync(command, cmdArgs, { cwd, stdio: 'inherit', env: process.env })

// ---------- 1. 服务端编译 ----------
console.log('== 1/6 编译服务端 TypeScript ==')
rmSync(path.join(release, '.build'), { recursive: true, force: true })
// engine.ts 目前有既有类型错误，编译仍会产出可运行的 JS，因此不因报错中断。
try {
  run('npx', ['tsc', '-p', 'tsconfig.build.json'])
} catch {
  console.log('   （tsc 报告了类型错误，已按既有状态继续产出 JS）')
}
if (!existsSync(path.join(release, '.build/decision-desk/server/index.js')))
  throw new Error('服务端没有编译出 index.js，打包中止')

// ---------- 2. 前端 ----------
console.log('== 2/6 构建前端 ==')
run('npm', ['--prefix', 'frontend', 'run', 'build'])

// ---------- 3. 组装应用目录 ----------
console.log('== 3/6 组装应用 ==')
rmSync(app, { recursive: true, force: true })
mkdirSync(app, { recursive: true })
cpSync(path.join(release, '.build/decision-desk'), path.join(app, 'decision-desk'), {
  recursive: true,
})
// decision-desk/server 运行时会 import 仓库根部的 src/，两者缺一后端起不来。
cpSync(path.join(release, '.build/src'), path.join(app, 'src'), { recursive: true })
cpSync(path.join(root, 'frontend/dist'), path.join(app, 'frontend/dist'), { recursive: true })
// src/*.js 依赖根 package.json 的 "type": "module" 才会被当作 ESM 加载。
writeFileSync(
  path.join(app, 'package.json'),
  JSON.stringify({ name: 'kanzheban-release', private: true, type: 'module', version }, null, 2),
)
// --frozen-lockfile 要求 package.json 与锁文件完全一致，先原样放入，装完再瘦身。
const desk = JSON.parse(readFileSync(path.join(root, 'decision-desk/package.json'), 'utf8'))
for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.env.example'])
  cpSync(path.join(root, 'decision-desk', file), path.join(app, 'decision-desk', file))

// ---------- 4. 运行期依赖 ----------
console.log('== 4/6 安装运行期依赖 ==')
// hoisted 布局不使用符号链接，压缩包在 Windows 上解压后依然可用。
run(
  'pnpm',
  [
    'install',
    '--prod',
    '--frozen-lockfile',
    '--node-linker=hoisted',
    '--ignore-scripts',
    '--no-optional',
  ],
  path.join(app, 'decision-desk'),
)
writeFileSync(
  path.join(app, 'decision-desk/package.json'),
  JSON.stringify(
    {
      name: desk.name,
      version: desk.version,
      private: true,
      type: 'module',
      engines: desk.engines,
      dependencies: desk.dependencies,
    },
    null,
    2,
  ),
)
rmSync(path.join(app, 'decision-desk/pnpm-lock.yaml'), { force: true })
rmSync(path.join(app, 'decision-desk/pnpm-workspace.yaml'), { force: true })

const natives = []
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walk(full)
    else if (entry.endsWith('.node')) natives.push(path.relative(app, full))
  }
}
walk(path.join(app, 'decision-desk/node_modules'))
if (natives.length) {
  console.log('   ⚠️ 发现平台原生模块，应用代码不再跨平台通用：')
  for (const item of natives.slice(0, 10)) console.log(`      ${item}`)
} else {
  console.log('   应用代码全部是纯 JavaScript，只有 Node 运行时按平台分发。')
}

// ---------- 5. Node 运行时 ----------
const fetchRuntime = (target) => {
  mkdirSync(cache, { recursive: true })
  const base = `node-${NODE_VERSION}-${target.dist}`
  const file = path.join(cache, `${base}.${target.kind === 'zip' ? 'zip' : 'tar.gz'}`)
  if (!existsSync(file)) {
    console.log(`   下载 ${base}…`)
    run('curl', ['-sL', '--fail', '-o', file, `${MIRROR}/${NODE_VERSION}/${path.basename(file)}`])
  }
  const out = path.join(cache, target.key)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  // 整个发行版有一百多兆，其中只有 node 可执行文件是运行所必需的。
  if (target.kind === 'zip') run('unzip', ['-j', '-q', '-o', file, `${base}/node.exe`, '-d', out])
  else run('tar', ['-xzf', file, '-C', out, '--strip-components=2', `${base}/bin/node`])
  const binary = path.join(out, target.kind === 'zip' ? 'node.exe' : 'node')
  if (!existsSync(binary)) throw new Error(`${target.key} 的 Node 运行时没有解出来`)
  return binary
}

// ---------- 6. 启动脚本 ----------
const unixLauncher = (bundled, open) => `#!/bin/bash
cd "$(dirname "$0")"
${
  bundled
    ? `# 运行时已随包分发，不使用系统里的 Node。
NODE="$PWD/runtime/node"
chmod +x "$NODE" 2>/dev/null
if [ ! -x "$NODE" ]; then
  echo "包内的 Node 运行时不可用，请重新完整解压压缩包。"
  read -n 1 -s -r -p "按任意键关闭"
  exit 1
fi`
    : `NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "没有找到 Node.js。请安装 Node.js 24 或更高版本：https://nodejs.org/zh-cn"
  read -n 1 -s -r -p "按任意键关闭"
  exit 1
fi`
}
export FRONTEND_DIST="$PWD/app/frontend/dist"
export DATA_DIR="$PWD/我的记录"
export PORT="\${PORT:-4317}"
echo "正在启动「看着办」，稍后会自动打开浏览器…"
(sleep 2 && ${open} "http://127.0.0.1:$PORT" >/dev/null 2>&1) &
cd app/decision-desk
"$NODE" server/index.js --production
`

// cmd.exe 按 OEM 代码页逐字节解析批处理文件，文件里出现 UTF-8 中文会让后续行的字节
// 偏移错乱（表现为 'ATA_DIR' 这类被切碎的命令）。所以启动脚本本身必须是纯 ASCII，
// 中文提示一律交给 Node 输出（chcp 65001 保证它显示正常）。嵌套引号同样容易被切碎，
// 因此把「等服务起来再开浏览器」拆成独立的 open-browser.cmd。
const winLauncher = (bundled) => `@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
${
  bundled
    ? `set "NODE=%cd%\\runtime\\node.exe"
if not exist "%NODE%" (
  echo [error] Bundled Node runtime not found. Please extract the whole zip again.
  pause
  exit /b 1
)`
    : `set "NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  echo [error] Node.js not found. Install Node.js 24+ from https://nodejs.org
  pause
  exit /b 1
)`
}
set "FRONTEND_DIST=%cd%\\app\\frontend\\dist"
set "DATA_DIR=%cd%\\data"
if "%PORT%"=="" set "PORT=4317"
echo Starting Kanzheban on http://127.0.0.1:%PORT% ...
if exist "open-browser.cmd" start "" /min cmd /c open-browser.cmd
cd app\\decision-desk
"%NODE%" server\\index.js --production
echo.
echo [stopped] Server exited.
pause
`

// 单独一个文件，避免在 start.cmd 里写嵌套引号。同样保持纯 ASCII。
const winBrowserOpener = `@echo off
timeout /t 4 /nobreak >nul
if "%PORT%"=="" set "PORT=4317"
start "" "http://127.0.0.1:%PORT%"
`

const pack = (name, build, doc = '使用说明.md') => {
  const stage = path.join(release, name)
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  cpSync(app, path.join(stage, 'app'), { recursive: true })
  cpSync(path.join(root, 'docs/离线包使用说明.md'), path.join(stage, doc))
  build(stage)
  const archive = path.join(release, `${name}.zip`)
  rmSync(archive, { force: true })
  // zip -X 不写 macOS 资源分支，Windows 解压不会多出 __MACOSX；Unix 权限位得以保留。
  run('zip', ['-r', '-q', '-X', archive, name], release)
  rmSync(stage, { recursive: true, force: true })
  console.log(`   ${path.basename(archive)}（${(statSync(archive).size / 1048576).toFixed(1)} MB）`)
}

console.log('== 5/6 准备 Node 运行时 ==')
const runtimes = new Map()
for (const target of targets) runtimes.set(target.key, fetchRuntime(target))

console.log('== 6/6 打包 ==')
if (!targets.length)
  pack(`看着办-v${version}-通用`, (stage) => {
    writeFileSync(path.join(stage, '启动.command'), unixLauncher(false, 'open'))
    writeFileSync(path.join(stage, 'start.sh'), unixLauncher(false, 'xdg-open'))
    writeFileSync(path.join(stage, '启动.cmd'), winLauncher(false))
    chmodSync(path.join(stage, '启动.command'), 0o755)
    chmodSync(path.join(stage, 'start.sh'), 0o755)
  })
for (const target of targets) {
  // 中文 Windows 用 GBK 代码页解 zip 条目名，而 Info-ZIP 不置 UTF-8 标志位，
  // 中文名会被解成非法文件名、报「压缩包无效」。Windows 包因此全部使用 ASCII 命名。
  const windows = target.kind === 'zip'
  const bundle = windows
    ? `kanzheban-v${version}-${target.key}`
    : `看着办-v${version}-${target.key}`
  pack(
    bundle,
    (stage) => {
      const runtime = path.join(stage, 'runtime')
      mkdirSync(runtime, { recursive: true })
      cpSync(runtimes.get(target.key), path.join(runtime, windows ? 'node.exe' : 'node'))
      if (windows) {
        writeFileSync(path.join(stage, 'start.cmd'), winLauncher(true))
        writeFileSync(path.join(stage, 'open-browser.cmd'), winBrowserOpener)
      } else {
        chmodSync(path.join(runtime, 'node'), 0o755)
        const mac = target.dist.startsWith('darwin')
        const file = mac ? '启动.command' : 'start.sh'
        writeFileSync(path.join(stage, file), unixLauncher(true, mac ? 'open' : 'xdg-open'))
        chmodSync(path.join(stage, file), 0o755)
      }
    },
    windows ? 'readme.md' : '使用说明.md',
  )
}
console.log('\n完成。产物在 release/ 下。')
