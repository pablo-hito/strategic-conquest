// Bundles the server (and the core/ai/protocol packages it uses) into one ESM file.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
await build({
  entryPoints: [here('../src/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: here('../dist/server.mjs'),
  external: ['ws'],
  alias: {
    '@sc/core': here('../../core/src/index.ts'),
    '@sc/ai': here('../../ai/src/index.ts'),
    '@sc/protocol': here('../../protocol/src/index.ts'),
  },
  banner: { js: '// Strategic Conquest game server (bundled)' },
});
console.log('dist/server.mjs');
