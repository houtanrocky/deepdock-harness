import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

function readConfig(configDir) {
  const file = path.join(configDir, 'config.json');
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
    throw new Error(`The bridge on port ${config.port} did not respond. Open the desktop app's Help tab for recovery, or check bridge/bridge.stderr.log for a source installation.`);
  }
  if (response.status === 401) {
    throw new Error('The running bridge uses a different token from the selected configuration. In the desktop app, use Force stop bridge, then Start bridge and Copy token. For a source bridge, stop tasks and close that old bridge console, then run start-deepdock.cmd.');
  }
  let data;
  try { data = await response.json(); } catch { throw new Error(`Port ${config.port} is not responding as a DeepDock Harness bridge.`); }
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
    throw new Error('This older bridge cannot report active work. Stop tasks, then use Force stop bridge in the desktop app, or close its console for a source installation.');
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

async function start(root, configDir, config, log) {
  if (typeof config.token !== 'string' || config.token.length < 32) throw new Error('The bridge token is missing or invalid. Run scripts/pair.ps1 first.');
  const bridgeDirectory = path.join(root, 'bridge');
  const expectedBuild = require(path.join(bridgeDirectory, 'build.js')).bridgeBuildId(bridgeDirectory);
  const status = await health(config);
  if (status?.buildId === expectedBuild) {
    log(`[DeepDock Harness] bridge already ready: ${status.toolCount} tools on port ${config.port}.`);
    return status;
  }
  if (status) {
    log('[DeepDock Harness] refreshing the idle bridge...');
    await stop(config, status);
  }
  const logDirectory = path.resolve(configDir) === path.resolve(bridgeDirectory) ? bridgeDirectory : path.join(configDir, 'logs');
  fs.mkdirSync(logDirectory, { recursive: true });
  const stdout = fs.openSync(path.join(logDirectory, 'bridge.stdout.log'), 'a');
  const stderr = fs.openSync(path.join(logDirectory, 'bridge.stderr.log'), 'a');
  let child;
  try {
    child = spawn(process.execPath, [path.join(bridgeDirectory, 'server.js')], {
      cwd: root, detached: true, windowsHide: true, stdio: ['ignore', stdout, stderr],
      env: { ...process.env, DEEPDOCK_CONFIG_DIR: configDir },
    });
  } finally { fs.closeSync(stdout); fs.closeSync(stderr); }
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  child.unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await delay(250);
    if (spawnError || child.exitCode !== null) throw new Error(`The bridge failed to start. See ${path.join(logDirectory, 'bridge.stderr.log')}.`);
    const loaded = await health(config);
    if (loaded?.buildId === expectedBuild) {
      log(`[DeepDock Harness] bridge ready: ${loaded.toolCount} tools on port ${config.port}.`);
      return loaded;
    }
  }
  throw new Error(`The bridge did not become ready. See ${path.join(logDirectory, 'bridge.stderr.log')}.`);
}

export async function manageBridge(action, { root = projectRoot, configDir = path.join(root, 'bridge'), rotateToken = false, log = console.log } = {}) {
  let config = readConfig(configDir);
  if (action === 'status') {
    if (!config) throw new Error('Bridge setup is incomplete. Run the installer or scripts/pair.ps1.');
    const status = await health(config);
    return { running: Boolean(status), address: `http://127.0.0.1:${config.port}`, workspace: config.allowedRoots?.[0] || '', activeTools: status?.activeTools || 0, activeHandoff: status?.activeHandoff || null };
  }
  if (action === 'pair') {
    const reusable = typeof config?.token === 'string' && config.token.length >= 32;
    if (reusable && !rotateToken) {
      await start(root, configDir, config, log);
      log('[DeepDock Harness] existing pairing reused; the token has not changed.');
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
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
    await start(root, configDir, config, log);
    log('[DeepDock Harness] new pairing saved and verified. Update the extension with the saved token.');
    return;
  }
  if (!config) throw new Error('bridge/config.json is missing. Run scripts/pair.ps1 first.');
  if (action === 'start') return start(root, configDir, config, log);
  if (action === 'stop') {
    const stopped = await stop(config);
    log(stopped ? '[DeepDock Harness] bridge stopped.' : '[DeepDock Harness] bridge is already stopped.');
    return;
  }
  throw new Error('Usage: node scripts/bridge.mjs start|stop|pair [--rotate-token]');
}

export async function stopConfiguredBridges({ root = projectRoot, appData = process.env.APPDATA, log = console.log } = {}) {
  const directories = [path.join(root, 'bridge'), ...(appData ? [path.join(appData, 'DeepDock')] : [])];
  const errors = [];
  let found = false;
  for (const configDir of new Set(directories.map((directory) => path.resolve(directory)))) {
    if (!fs.existsSync(path.join(configDir, 'config.json'))) continue;
    found = true;
    try { await manageBridge('stop', { root, configDir, log }); }
    catch (error) { errors.push(error.message); }
  }
  if (!found) log('[DeepDock Harness] No configured bridge found; nothing to stop.');
  if (errors.length) throw new Error(errors.join('\n'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  const operation = action === 'stop' ? stopConfiguredBridges() : manageBridge(action, { rotateToken: process.argv.includes('--rotate-token') });
  operation.catch((error) => {
    console.error('[DeepDock Harness] ' + error.message);
    process.exitCode = 1;
  });
}
