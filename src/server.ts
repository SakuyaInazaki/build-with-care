// Compatibility entry point: all product startup paths launch the same backend.
import { fileURLToPath } from 'node:url'

process.env.FRONTEND_ROOT ??= fileURLToPath(new URL('../frontend/', import.meta.url))
process.env.FRONTEND_DIST ??= fileURLToPath(new URL('../frontend/dist/', import.meta.url))
process.env.DATA_DIR ??= fileURLToPath(new URL('../frontend/.data/runs/', import.meta.url))
await import(new URL('../decision-desk/server/index.ts', import.meta.url).href)
