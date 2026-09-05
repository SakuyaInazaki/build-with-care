import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/ui',
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:4318',
    channel: process.env.PLAYWRIGHT_CHANNEL ?? 'msedge',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm start',
    url: 'http://127.0.0.1:4318',
    timeout: 30000,
    reuseExistingServer: false,
    env: { PORT: '4318', DATA_DIR: '.data/ui-tests' },
  },
})
