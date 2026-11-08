import { startServer } from './server.js';

const port = Number(process.env.PORT ?? 8080);
startServer({
  port,
  dataDir: process.env.DATA_DIR ?? './data',
  clientFile: process.env.CLIENT_FILE ?? new URL('../../client/dist/play.html', import.meta.url).pathname,
  graceMs: Number(process.env.GRACE_MS ?? 20_000),
  log: (m) => console.log(`[sc] ${m}`),
}).then((s) => {
  const stop = () => s.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
});
