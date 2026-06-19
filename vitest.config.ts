import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      // Pure-core modules must not import `obsidian`. If a test transitively
      // pulls it in, fail loudly rather than resolving the real package, which
      // has no Node entrypoint. (Obsidian-bound code is tested via its own stub.)
      obsidian: resolve(__dirname, 'test/obsidian-stub.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
