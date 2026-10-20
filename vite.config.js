import { fileURLToPath, URL } from 'node:url'

import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // Only the app's own unit tests. supabase/tests holds standalone Node scripts
  // (run with `node supabase/tests/<file>.cjs`) and SQL; Vitest must not collect
  // them, or `npm test` (and the deploy workflow that runs it) fails.
  test: {
    include: ['src/**/*.test.{js,jsx,ts,tsx}'],
  },
})
