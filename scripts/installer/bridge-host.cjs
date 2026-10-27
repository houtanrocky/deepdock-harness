'use strict';

// The desktop app and installed CMD scripts share the repository controller.
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const { manageBridge } = await import(pathToFileURL(path.join(__dirname, 'scripts', 'bridge.mjs')).href);
  const configDir = path.join(process.env.APPDATA, 'DeepDock');
  const action = process.argv[2];
  if (!['start', 'stop', 'status'].includes(action)) throw new Error('Choose start, stop, or status.');
  const options = { root: __dirname, configDir, log() {} };
  const result = await manageBridge(action, options);
  const status = action === 'status' ? result : await manageBridge('status', options);
  process.stdout.write(JSON.stringify({ ok: true, ...status }));
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
});
