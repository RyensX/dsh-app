import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig(({ mode }) => {
  const lite = mode === 'lite'
  const input = lite ? 'lite.html' : 'index.html'

  return {
    clearScreen: false,
    server: {
      host: '127.0.0.1',
      port: 1420,
      strictPort: true,
    },
    build: {
      target: ['es2022', 'chrome105', 'safari13'],
      outDir: lite ? 'dist/lite' : 'dist/bundled',
      emptyOutDir: true,
      rollupOptions: {
        input: resolve(import.meta.dirname, input),
      },
    },
  }
})
