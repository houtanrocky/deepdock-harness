'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const appData = process.env.APPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Roaming');
const configDir = path.join(appData, 'DeepDock');
const configPath = path.join(configDir, 'config.json');
const installDir = __dirname;
const logDir = path.join(configDir, 'logs');

function loadConfig() {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!Number.isInteger(Number(config.port)) || !config.token) throw new Error('DeepDock setup is incomplete. Run the installer again.');
  return config;
}

async function request(config, endpoint, method = 'GET') {
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}${endpoint}`, {
      method,
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(1500),
    });
    return response;
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED' || error.name === 'TimeoutError') return null;
    throw error;
  }
}

async function main() {
  const config = loadConfig();
  process.env.DEEPDOCK_CONFIG_DIR = configDir;
  if (process.argv[2] === 'stop') {
    const response = await request(config, '/shutdown', 'POST');
    if (response?.ok) return;
    if (!response) return;
    const message = response.status === 409 ? 'A coding task is still running. Stop it before closing the bridge.' : `Bridge stopped with HTTP ${response.status}.`;
    throw new Error(message);
  }

  const existing = await request(config, '/health');
  if (existing) {
    const data = await existing.json().catch(() => null);
    if (data?.name === 'dsh-pro' || data?.name === 'deepdock') return;
    throw new Error(`Port ${config.port} is being used by another app. Change the port in ${configPath}.`);
  }

  fs.mkdirSync(logDir, { recursive: true });
  const stdout = fs.openSync(path.join(logDir, 'bridge.stdout.log'), 'a');
  const stderr = fs.openSync(path.join(logDir, 'bridge.stderr.log'), 'a');
  const child = spawn(process.execPath, [path.join(installDir, 'bridge', 'server.js')], {
    cwd: installDir,
    detached: true,
    windowsHide: true,
    env: { ...process.env, DEEPDOCK_CONFIG_DIR: configDir },
    stdio: ['ignore', stdout, stderr],
  });
  child.once('error', (error) => {
    fs.appendFileSync(path.join(logDir, 'bridge.stderr.log'), `${error.stack || error}\n`);
  });
  child.unref();
  fs.closeSync(stdout);
  fs.closeSync(stderr);
}

main().catch((error) => {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'bridge.stderr.log'), `[DeepDock] ${error.message}\n`);
  } catch {}
});
