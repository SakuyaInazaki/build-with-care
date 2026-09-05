import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const backend = fileURLToPath(new URL('../decision-desk/', import.meta.url))
const development = process.argv.includes('--dev')
const child = spawn(
  process.execPath,
  ['--import', 'tsx', 'server/index.ts', ...(development ? [] : ['--production'])],
  {
    cwd: backend,
    stdio: 'inherit',
    env: {
      ...process.env,
      FRONTEND_DIST: fileURLToPath(new URL('./dist/', import.meta.url)),
      FRONTEND_ROOT: fileURLToPath(new URL('./', import.meta.url)),
      DATA_DIR: process.env.DATA_DIR ?? fileURLToPath(new URL('./.data/runs/', import.meta.url)),
    },
  },
)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('error', (error) => {
  console.error(error.message)
  process.exitCode = 1
})
child.on('exit', (code) => {
  process.exitCode = code ?? 0
})
