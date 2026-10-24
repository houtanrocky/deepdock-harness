import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

function readConfig(root) {
  const file = path.join(root, 'bridge', 'config.json');
  if (!fs.existsSync(file)) return null;
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('Could not parse bridge/config.json. Repair its JSON before starting or pairing.'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('bridge/config.json must contain a configuration object.');
  const port = Number(config.port ?? 8765);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('bridge/config.json has an invalid port.');
  return { ...config, port };
}

async function request(config, endpoint, method = 'GET') {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${config.port}${endpoint}`, {
      method,
      headers: { Authorization: `Bearer ${config.token || ''}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return null;
    throw new Error(`The bridge on port ${config.port} did not respond. Check its console or bridge/bridge.stderr.log.`);
  }
  if (response.status === 401) {
    throw new Error('The running bridge uses a different token from bridge/config.json. An older pair.ps1 could change the file without restarting the bridge. Stop tasks and close that old bridge console, then run start-deepdock.cmd. Pairing now reuses the saved token by default.');
  }
  let data;
  try { data = await response.json(); } catch { throw new Error(`Port ${config.port} is not responding as a DeepDock bridge.`); }
  if (!response.ok || !data.ok) throw new Error(data.error?.message || `Bridge request failed (HTTP ${response.status}).`);
  return data;
}

async function health(config) {
  const data = await request(config, '/health');
  if (data && !['dsh-pro', 'deepdock'].includes(data.name)) throw new Error(`Port ${config.port} is occupied by another service.`);
  return data;
}

function assertIdle(status) {
  if (typeof status.activeTools !== 'number' || !Object.hasOwn(status, 'activeHandoff')) {
    throw new Error('This older bridge cannot report active work. Stop tasks and close its console before starting the updated bridge.');
  }
  if (status.activeTools || status.activeHandoff) throw new Error('The bridge has active work. Stop or finish the task before restarting, stopping, or rotating its token.');
}

async function stop(config, status = undefined) {
  status ??= await health(config);
  if (!status) return false;
  assertIdle(status);
  await request(config, '/shutdown', 'POST');
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await delay(250);
    if (!await health(config)) return true;
  }
  throw new Error('The bridge did not stop. Check its console before trying again.');
}

async function start(root, config, log) {
  if (typeof config.token !== 'string' || config.token.length < 32) throw new Error('The bridge token is missing or invalid. Run scripts/pair.ps1 first.');
  const bridgeDirectory = path.join(root, 'bridge');
  const expectedBuild = require(path.join(bridgeDirectory, 'build.js')).bridgeBuildId(bridgeDirectory);
  const status = await health(config);
  if (status?.buildId === expectedBuild) {
    log(`[DeepDock] bridge already ready: ${status.toolCount} tools on port ${config.port}.`);
    return status;
  }
  if (status) {
    log('[DeepDock] refreshing the idle bridge...');
    await stop(config, status);
  }
  const stdout = fs.openSync(path.join(bridgeDirectory, 'bridge.stdout.log'), 'a');
  const stderr = fs.openSync(path.join(bridgeDirectory, 'bridge.stderr.log'), 'a');
  let child;
  try {
    child = spawn(process.execPath, [path.join(bridgeDirectory, 'server.js')], {
      cwd: root, detached: true, windowsHide: true, stdio: ['ignore', stdout, stderr],
    });
  } finally { fs.closeSync(stdout); fs.closeSync(stderr); }
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  child.unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await delay(250);
    if (spawnError || child.exitCode !== null) throw new Error('The bridge failed to start. See bridge/bridge.stderr.log.');
    const loaded = await health(config);
    if (loaded?.buildId === expectedBuild) {
      log(`[DeepDock] bridge ready: ${loaded.toolCount} tools on port ${config.port}.`);
      return loaded;
    }
  }
  throw new Error('The bridge did not become ready. See bridge/bridge.stderr.log.');
}

export async function manageBridge(action, { root = projectRoot, rotateToken = false, log = console.log } = {}) {
  let config = readConfig(root);
  if (action === 'pair') {
    const reusable = typeof config?.token === 'string' && config.token.length >= 32;
    if (reusable && !rotateToken) {
      await start(root, config, log);
      log('[DeepDock] existing pairing reused; the token has not changed.');
      return;
    }
    // Authenticate and stop the old idle process BEFORE changing credentials.
    // Failure leaves the existing configuration untouched.
    if (config) await stop(config);
    config ??= {
      port: 8765, allowedRoots: [root], bashTimeoutMs: 20000, bashTimeoutMaxMs: 120000,
      handoffTimeoutMs: 300000, handoffTimeoutMaxMs: 1800000, dailySendLimit: 200,
    };
    config.token = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(root, 'bridge', 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
    await start(root, config, log);
    log('[DeepDock] new pairing saved and verified. Update the extension with the saved token.');
    return;
  }
  if (!config) throw new Error('bridge/config.json is missing. Run scripts/pair.ps1 first.');
  if (action === 'start') return start(root, config, log);
  if (action === 'stop') {
    const stopped = await stop(config);
    log(stopped ? '[DeepDock] bridge stopped.' : '[DeepDock] bridge is already stopped.');
    return;
  }
  throw new Error('Usage: node scripts/bridge.mjs start|stop|pair [--rotate-token]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  manageBridge(process.argv[2], { rotateToken: process.argv.includes('--rotate-token') }).catch((error) => {
    console.error('[DeepDock] ' + error.message);
    process.exitCode = 1;
  });
}
