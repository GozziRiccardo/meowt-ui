import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'valtio/vanilla/utils': path.resolve(__dirname, 'src/shims/valtio-vanilla-utils.ts'),
      'valtio/vanilla': path.resolve(__dirname, 'src/shims/valtio-vanilla.ts'),
    },
  },
})
