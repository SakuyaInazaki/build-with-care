import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4321,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4317' },
      '/artifacts': { target: 'http://127.0.0.1:4317' },
    },
  },
})
