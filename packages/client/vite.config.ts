import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: { '@sc/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) },
  },
});
