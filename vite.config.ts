import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { installationFilesPlugin } from './bff/installationDevServer.mjs'

export default defineConfig({
  plugins: [react(), installationFilesPlugin()],
  base: './',
  server: {
    proxy: {
      '/api/console/v0': 'http://127.0.0.1:8787',
      '/api/wjax-kind': 'http://127.0.0.1:8791',
    },
  },
  test: {
    environment: 'jsdom',
    exclude: [...configDefaults.exclude, 'e2e/**'],
    setupFiles: './src/test/setup.ts',
  },
})
