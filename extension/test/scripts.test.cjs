const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { manageBridge } = require('../../scripts/bridge.mjs');
const exec = promisify(execFile);
const project = path.resolve(__dirname, '../..');
const TOKEN = 'fixture-pairing-token'.padEnd(64, '0');

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
async function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepdock scripts-'));
  fs.cpSync(path.join(project, 'bridge'), path.join(root, 'bridge'), {
    recursive: true, filter: (file) => !/\.(?:log|jsonl)$/.test(file) && path.basename(file) !== 'config.json',
  });
  fs.cpSync(path.join(project, 'scripts'), path.join(root, 'scripts'), { recursive: true });
  const probe = http.createServer();
  const port = await listen(probe);
  await close(probe);
  const file = path.join(root, 'bridge/config.json');
  fs.writeFileSync(file, JSON.stringify({ token: TOKEN, port, allowedRoots: [root], ...overrides }, null, 2));
  const manage = (action, options = {}) => manageBridge(action, { root, log() {}, ...options });
  t.after(async () => {
    // Only this fixture's authenticated process can be shut down by cleanup.
    try { await manage('stop'); } catch {}
    const absolute = fs.realpathSync(root);
    assert.ok(absolute.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    assert.ok(path.basename(absolute).startsWith('deepdock scripts-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, port, file, manage, config: () => JSON.parse(fs.readFileSync(file)) };
}
async function mock(t, handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const [status, body] = handler(req);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  const port = await listen(server);
  t.after(() => close(server));
  return { port, calls };
}

test('pairing and startup reuse the saved token and existing bridge process', async (t) => {
  const f = await fixture(t);
  const before = fs.readFileSync(f.file, 'utf8');
  await f.manage('pair');
  const first = await f.manage('start');
  await f.manage('pair');
  const second = await f.manage('start');
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.equal(second.buildId, first.buildId);
  assert.equal(second.activeTools, 0);
  const response = await fetch(`http://127.0.0.1:${f.port}/tools`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const catalog = await response.json();
  assert.equal(second.toolCount, catalog.tools.length);
  assert.equal(catalog.tools.some((tool) => tool.name === 'dsh_handoff'), second.dsh.available);
});

test('explicit token rotation restarts an idle bridge before copying the new credentials', async (t) => {
  const f = await fixture(t);
  await f.manage('start');
  const before = await f.manage('start');
  await f.manage('pair', { rotateToken: true });
  const config = f.config();
  assert.match(config.token, /^[a-f0-9]{64}$/);
  assert.notEqual(config.token, TOKEN);
  const after = await f.manage('start');
  assert.notEqual(after.buildId, before.buildId);
  const rejected = await fetch(`http://127.0.0.1:${f.port}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(rejected.status, 401);
});

test('first pairing creates a valid token while preserving configured workspaces and port', async (t) => {
  const f = await fixture(t, { token: '' });
  await f.manage('pair');
  assert.match(f.config().token, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.config().allowedRoots, [f.root]);
  assert.equal(f.config().port, f.port);
  assert.equal((await f.manage('start')).activeTools, 0);
  await f.manage('stop');
  await f.manage('stop'); // Already stopped is a successful no-op.
});

test('active tools and handoffs block startup refresh, shutdown, and token rotation', async (t) => {
  for (const busy of [{ activeTools: 1, activeHandoff: null }, { activeTools: 0, activeHandoff: 'busy-run' }]) {
    const service = await mock(t, () => [200, { ok: true, name: 'dsh-pro', buildId: 'older', ...busy }]);
    const f = await fixture(t, { port: service.port });
    const before = fs.readFileSync(f.file, 'utf8');
    for (const action of ['start', 'stop', 'pair']) {
      await assert.rejects(f.manage(action, { rotateToken: true }), /active work/);
    }
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
    assert.ok(service.calls.every((call) => call === 'GET /health'));
  }
});

test('a shutdown rejected after health inspection leaves the pairing unchanged', async (t) => {
  const service = await mock(t, (req) => req.url === '/health'
    ? [200, { ok: true, name: 'dsh-pro', activeTools: 0, activeHandoff: null }]
    : [409, { ok: false, error: { message: 'Work started before shutdown' } }]);
  const f = await fixture(t, { port: service.port });
  const before = fs.readFileSync(f.file, 'utf8');
  await assert.rejects(f.manage('pair', { rotateToken: true }), /Work started/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});

test('401 produces actionable recovery instructions without rotating or exposing the token', async (t) => {
  const service = await mock(t, () => [401, { ok: false }]);
  const f = await fixture(t, { port: service.port });
  const before = fs.readFileSync(f.file, 'utf8');
  for (const action of ['start', 'stop', 'pair']) await assert.rejects(f.manage(action), /different token/);
  await assert.rejects(f.manage('pair', { rotateToken: true }), /different token/);
  await assert.rejects(exec(process.execPath, [path.join(f.root, 'scripts/bridge.mjs'), 'start'], { windowsHide: true, timeout: 15000 }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /close that old bridge console/);
    assert.ok(!error.stderr.includes(TOKEN));
    return true;
  });
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.ok(service.calls.every((call) => call === 'GET /health'));
});

test('a different service on the configured port is never shut down', async (t) => {
  const service = await mock(t, () => [200, { ok: true, name: 'another-service' }]);
  const f = await fixture(t, { port: service.port });
  await assert.rejects(f.manage('start'), /another service/);
  await assert.rejects(f.manage('stop'), /another service/);
  assert.ok(service.calls.every((call) => call === 'GET /health'));
});

test('PowerShell pairing wrapper reuses credentials and copies only the verified token', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  const psQuote = (value) => "'" + value.replaceAll("'", "''") + "'";
  const script = `function Set-Clipboard { [CmdletBinding()] param([string]$Value) if ($Value -ne '${TOKEN}') { throw 'Unexpected fixture token' } }; & ${psQuote(path.join(f.root, 'scripts/pair.ps1'))}; exit $LASTEXITCODE`;
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  const before = fs.readFileSync(f.file, 'utf8');
  for (let i = 0; i < 2; i++) {
    // File-backed output avoids waiting for inherited pipe handles in a detached
    // Windows descendant after the PowerShell command itself has already exited.
    const output = path.join(f.root, `pair-${i}.stdout`);
    const errors = path.join(f.root, `pair-${i}.stderr`);
    const out = fs.openSync(output, 'w');
    const err = fs.openSync(errors, 'w');
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', out, err] });
    fs.closeSync(out); fs.closeSync(err);
    const timer = setTimeout(() => child.kill(), 15000);
    try {
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      assert.equal(code, 0, fs.readFileSync(errors, 'utf8'));
    } finally { clearTimeout(timer); }
    const stdout = fs.readFileSync(output, 'utf8');
    assert.match(stdout, /existing pairing reused/);
    assert.match(stdout, /verified token copied/);
    assert.ok(!stdout.includes(TOKEN));
  }
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});
