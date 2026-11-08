import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  resolve: {
    alias: {
      '@sc/core': here('../core/src/index.ts'),
      '@sc/ai': here('../ai/src/index.ts'),
      '@sc/protocol': here('../protocol/src/index.ts'),
    },
  },
});
