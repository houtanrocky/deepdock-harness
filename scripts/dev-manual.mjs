import { createServer } from 'wxt';
import { fileURLToPath } from 'node:url';

const server = await createServer({
  root: fileURLToPath(new URL('../', import.meta.url)),
  webExt: { disabled: true },
});
await server.start();

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.stop();
  process.exit(0);
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
