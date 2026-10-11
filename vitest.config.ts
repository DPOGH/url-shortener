import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Vitest 5 prefers oxc for transforms; keep Hono JSX working in tests.
  oxc: {
    jsx: {
      runtime: 'automatic',
      importSource: 'hono/jsx'
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 20000
  }
})
