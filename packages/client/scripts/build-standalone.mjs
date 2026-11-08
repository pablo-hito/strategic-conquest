// Bundles the viewer into ONE self-contained HTML fragment (inline CSS + JS) that can
// be opened directly or published as a claude.ai artifact. Fonts come from Google Fonts.
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

const result = await build({
  entryPoints: [here('../src/main.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  write: false,
  alias: { '@sc/core': here('../../core/src/index.ts'), '@sc/ai': here('../../ai/src/index.ts'), '@sc/protocol/client': here('../../protocol/src/client.ts'), '@sc/protocol': here('../../protocol/src/index.ts') },
  legalComments: 'none',
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const css = await readFile(here('../src/style.css'), 'utf8');
const fontImport = css.match(/@import url\('([^']+)'\);/);
const cssBody = css.replace(/@import url\('[^']+'\);\s*/, '');

const html = `<title>Strategic Conquest</title>
<meta name="description" content="Remake táctico de Strategic Conquest: partida local por turnos con niebla de guerra.">
${fontImport ? `<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link rel="stylesheet" href="${fontImport[1]}">` : ''}
<style>
${cssBody}
</style>
<script>
${js}
</script>
`;

await mkdir(here('../dist'), { recursive: true });
await writeFile(here('../dist/strategic-conquest.html'), html);
// Full page for the game server (the artifact viewer adds its own document shell).
const cut = html.indexOf('<script>');
const page = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${html.slice(0, cut)}</head>
<body>
${html.slice(cut)}</body>
</html>
`;
await writeFile(here('../dist/play.html'), page);
console.log(`dist/strategic-conquest.html  ${(html.length / 1024).toFixed(1)} KB`);
