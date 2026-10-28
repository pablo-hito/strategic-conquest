import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@sc/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@sc/ai': fileURLToPath(new URL('../ai/src/index.ts', import.meta.url)),
    },
  },
});
