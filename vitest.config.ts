import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Minimal Vitest config for offline unit tests (Slice 3).
// - `@` alias mirrors tsconfig paths so tests can import `@/lib/...`.
// - node environment; these are pure logic tests with no DOM.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
