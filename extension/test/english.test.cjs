'use strict';

// Run from the extension directory: node --test test/english.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { TOOL_DEFS, runTool, checkBashCommand } = require('../../bridge/tools');
const guard = require('../../bridge/guard');

const extensionDir = path.resolve(__dirname, '..');
const english = (text) => assert.doesNotMatch(text, /\p{Script=Han}/u);
const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-english-test-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const config = { token: 'test-token'.padEnd(64, '0'), allowedRoots: [workspace], bashTimeoutMs: 20000, bashTimeoutMaxMs: 120000, handoffTimeoutMs: 300000, handoffTimeoutMaxMs: 1800000 };
  return { workspace, config };
}

function loadBridge(filename, overrides, suffix = '') {
  const file = path.resolve(extensionDir, '../bridge', filename);
  const localRequire = createRequire(file);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + suffix, {
    require: (name) => Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name),
    module, __dirname: path.dirname(file), Buffer, setTimeout, clearTimeout,
    console: { log() {}, error() {} }, process: { env: process.env, on() {} },
  }, { filename: file });
  return module.exports;
}

test('bridge file operations preserve content, hashes, validation, and English errors', async (t) => {
  const { workspace, config } = fixture(t);
  const ctx = { workspace, config, confirmed: false };
  const content = 'First line\n用户 data\n';
  const written = await runTool('dsh_write', { path: 'sample.txt', content }, ctx);
  const read = await runTool('dsh_read', { path: 'sample.txt' }, ctx);
  assert.equal(read.sha256, written.sha256);
  assert.match(read.content, /2 \| 用户 data/);
  await runTool('dsh_edit', { path: 'sample.txt', oldText: 'First', newText: 'Updated', expectedSha256: read.sha256 }, ctx);
  assert.equal(fs.readFileSync(path.join(workspace, 'sample.txt'), 'utf8'), content.replace('First', 'Updated'));
  for (const [tool, args, code] of [
    ['dsh_edit', { path: 'sample.txt', oldText: 'Updated', newText: 'Oops', expectedSha256: read.sha256 }, 'E_STALE_FILE'],
    ['dsh_read', { path: 'missing.txt' }, 'E_ARGS_INVALID'],
    ['dsh_read', { path: '../outside.txt' }, 'E_PATH_ESCAPE'],
    ['dsh_read', { path: '.env' }, 'E_FORBIDDEN_PATH'],
    ['dsh_unknown', {}, 'E_TOOL_NOT_FOUND'],
    ['dsh_bash', { command: 'echo hello' }, 'E_NEEDS_CONFIRM'],
  ]) {
    await assert.rejects(runTool(tool, args, ctx), (error) => {
      assert.equal(error.code, code);
      english(error.message);
      return true;
    });
  }
  assert.equal(checkBashCommand('git status').verdict, 'allow');
  for (const command of ['rm -rf /', 'git push', 'dir | whoami']) {
    assert.throws(() => checkBashCommand(command), (error) => error.code === 'E_BASH_BLOCKED');
  }
});

test('handoff sends an English task instruction and preserves the original plan', (t) => {
  const { workspace, config } = fixture(t);
  let commandArgs;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 123;
  const { HandoffManager } = loadBridge('handoff.js', {
    child_process: {
      spawnSync: () => ({ status: 0 }),
      spawn: (command, args) => { commandArgs = args; return child; },
    },
  });
  config.dshBin = __filename;
  const manager = new HandoffManager(config);
  const planText = 'Keep user data unchanged: 用户';
  const started = manager.start({ workspace, planText, taskNote: 'Test task' });
  t.after(() => clearTimeout(manager.runs.get(started.runId).timer));
  english(commandArgs[3]);
  assert.match(commandArgs[3], /Communicate in English/);
  assert.deepEqual(plain(commandArgs.slice(1, 3)), ['--profile', 'headless']);
  assert.equal(fs.readFileSync(path.join(workspace, started.planFile), 'utf8'), planText);
  assert.equal(manager.cancel(started.runId).status, 'cancelled');
  assert.equal(manager.get(started.runId).note, 'Cancelled by user');
  assert.throws(() => manager.cancel('missing'), /No running handoff found/);
});

test('bridge routes keep their schemas and confirmation tokens with English messages', async (t) => {
  const { workspace, config } = fixture(t);
  const server = loadBridge('server.js', {
    './guard': { ...guard, loadConfig: () => config },
    './handoff': { HandoffManager: class {}, dshProbe: () => ({ binFound: false }) },
    http: { createServer: () => ({ listen() {} }) },
    fs: { ...fs, appendFileSync() {} },
  }, '\nmodule.exports = { handle };');
  const tools = await server.handle({}, {}, '/tools', null);
  assert.equal(tools.ok, true);
  assert.equal(tools.tools.length, TOOL_DEFS.length);
  english(JSON.stringify(tools));
  for (const [route, body, code] of [
    ['/tool', {}, 'E_ARGS_INVALID'],
    ['/missing', {}, 'E_TOOL_NOT_FOUND'],
    ['/handoff', {}, 'E_ARGS_INVALID'],
    ['/tool', { tool: 'dsh_bash', args: { command: 'echo hello' }, workspace }, 'E_NEEDS_CONFIRM'],
  ]) {
    await assert.rejects(server.handle({ method: 'GET' }, {}, route, body), (error) => {
      assert.equal(error.code, code);
      english(error.message);
      if (code === 'E_NEEDS_CONFIRM') assert.match(error.extra.confirmToken, /^[a-f0-9]{32}$/);
      return true;
    });
  }
});

test('sensitive writes and edits require confirmation before changing files', async (t) => {
  const { workspace, config } = fixture(t);
  const ctx = { workspace, config, confirmed: false };
  const file = path.join(workspace, 'package.json');
  const original = '{"name":"before"}';
  fs.writeFileSync(file, original);
  for (const [tool, args] of [
    ['dsh_write', { path: 'package.json', content: '{"name":"after"}' }],
    ['dsh_edit', { path: 'package.json', oldText: 'before', newText: 'after' }],
  ]) {
    await assert.rejects(runTool(tool, args, ctx), (error) => error.code === 'E_NEEDS_CONFIRM');
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    await runTool(tool, args, { ...ctx, confirmed: true });
    assert.equal(fs.readFileSync(file, 'utf8'), '{"name":"after"}');
    fs.writeFileSync(file, original);
  }
});

test('confirmation tokens are single-use and bound to the exact publishing request', async (t) => {
  const { workspace, config } = fixture(t);
  const executed = [];
  const server = loadBridge('server.js', {
    './guard': { ...guard, loadConfig: () => config },
    './handoff': { HandoffManager: class {}, dshProbe: () => ({ binFound: false }) },
    './tools': { TOOL_DEFS, runTool: async (name, args, ctx) => {
      if (!ctx.confirmed) throw new guard.ToolError('E_NEEDS_CONFIRM', 'Confirm publishing');
      executed.push({ name, args });
      return { published: true };
    } },
    http: { createServer: () => ({ listen() {} }) },
    fs: { ...fs, appendFileSync() {} },
  }, '\nmodule.exports = { handle };');
  const body = { tool: 'dsh_github_create', args: { path: '.', repository: 'example/first' }, workspace };
  async function token() {
    try { await server.handle({}, {}, '/tool', body); }
    catch (error) { assert.equal(error.code, 'E_NEEDS_CONFIRM'); return error.extra.confirmToken; }
    assert.fail('Expected confirmation');
  }
  const mismatched = await token();
  await assert.rejects(server.handle({}, {}, '/tool', { ...body, args: { ...body.args, repository: 'example/other' }, confirmToken: mismatched }), /does not match/);
  assert.equal(executed.length, 0);
  const matching = await token();
  assert.equal((await server.handle({}, {}, '/tool', { ...body, confirmToken: matching })).ok, true);
  assert.equal(executed.length, 1);
  await assert.rejects(server.handle({}, {}, '/tool', { ...body, confirmToken: matching }), (error) => error.code === 'E_NEEDS_CONFIRM');
  assert.equal(executed.length, 1);
});

test('Full access permits compound shell commands while other modes keep the command checks', async (t) => {
  const { workspace, config } = fixture(t);
  const args = { command: 'echo first && echo second' };
  const ctx = { config, workspace, confirmed: true };
  for (const permissionMode of ['important', 'always']) await assert.rejects(runTool('dsh_bash', args, { ...ctx, permissionMode }), (error) => error.code === 'E_BASH_BLOCKED');
  const result = await runTool('dsh_bash', args, { ...ctx, permissionMode: 'full' });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /first/);
  assert.match(result.stdout, /second/);
});

test('failed commands include exit status and output even when the shell emits no diagnostics', async (t) => {
  const { workspace, config } = fixture(t);
  const ctx = { config, workspace, permissionMode: 'full' };
  const command = process.platform === 'win32' ? 'exit /b 255' : 'exit 255';
  await assert.rejects(runTool('dsh_bash', { command }, ctx), (error) => {
    assert.equal(error.code, 'E_COMMAND_FAILED');
    assert.equal(error.extra.exitCode, 255);
    assert.equal(error.extra.stdout, '');
    assert.equal(error.extra.stderr, '');
    assert.match(error.message, /no stdout or stderr/);
    assert.match(error.extra.shell, process.platform === 'win32' ? /cmd\.exe$/i : /\/bin\/sh$/);
    return true;
  });
  const diagnostic = process.platform === 'win32' ? 'echo diagnostic 1>&2 && exit /b 7' : 'echo diagnostic >&2; exit 7';
  await assert.rejects(runTool('dsh_bash', { command: diagnostic }, ctx), (error) => {
    assert.equal(error.extra.exitCode, 7);
    assert.match(error.extra.stderr, /diagnostic/);
    return error.code === 'E_COMMAND_FAILED';
  });
});

test('large writes work and hash-checked chunk appends reject duplicate retries and stale files', async (t) => {
  const { workspace, config } = fixture(t);
  const ctx = { workspace, config, confirmed: false };
  const content = '# Incident report\nفارسی; "quotes"; \\paths\n'.repeat(200);
  const written = await runTool('dsh_write', { path: 'large.md', content }, ctx);
  assert.ok(written.bytesWritten > 6000);
  assert.equal(fs.readFileSync(path.join(workspace, 'large.md'), 'utf8'), content);

  const first = 'First chunk\n';
  const second = 'Second chunk: فارسی\n';
  const created = await runTool('dsh_write', { path: 'chunked.md', content: first }, ctx);
  const read = await runTool('dsh_read', { path: 'chunked.md' }, ctx);
  assert.equal(created.sha256, read.sha256);
  const args = { path: 'chunked.md', content: second, append: true, expectedSha256: read.sha256 };
  const appended = await runTool('dsh_write', args, ctx);
  assert.equal(appended.appended, true);
  assert.equal(appended.created, false);
  assert.equal(fs.readFileSync(path.join(workspace, 'chunked.md'), 'utf8'), first + second);
  assert.equal((await runTool('dsh_read', { path: 'chunked.md' }, ctx)).sha256, appended.sha256);
  await assert.rejects(runTool('dsh_write', args, ctx), (error) => error.code === 'E_STALE_FILE');
  for (const invalid of [{ append: 'false' }, { append: true }, { append: true, expectedSha256: '' }]) {
    await assert.rejects(runTool('dsh_write', { path: 'chunked.md', content: 'bad', ...invalid }, ctx), (error) => error.code === 'E_ARGS_INVALID');
  }
  await assert.rejects(runTool('dsh_write', { ...args, path: 'missing.md' }, ctx), (error) => error.code === 'E_STALE_FILE');
  await assert.rejects(runTool('dsh_write', { ...args, path: '../outside.md' }, ctx), (error) => error.code === 'E_PATH_ESCAPE');
  fs.writeFileSync(path.join(workspace, 'chunked.md'), 'External change');
  await assert.rejects(runTool('dsh_write', { ...args, expectedSha256: appended.sha256 }, ctx), (error) => error.code === 'E_STALE_FILE');
  assert.equal(fs.readFileSync(path.join(workspace, 'chunked.md'), 'utf8'), 'External change');
});

test('append retains sensitive-file confirmation and enforces the final content size', async (t) => {
  const { workspace, config } = fixture(t);
  const ctx = { workspace, config, confirmed: false };
  const created = await runTool('dsh_write', { path: 'package.json', content: '{}' }, { ...ctx, confirmed: true });
  await assert.rejects(runTool('dsh_write', { path: 'package.json', content: '\n', append: true, expectedSha256: created.sha256 }, ctx), (error) => error.code === 'E_NEEDS_CONFIRM');
  assert.equal(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'), '{}');
  const full = 'x'.repeat(2 * 1024 * 1024);
  const large = await runTool('dsh_write', { path: 'full.txt', content: full }, ctx);
  await assert.rejects(runTool('dsh_write', { path: 'full.txt', content: 'x', append: true, expectedSha256: large.sha256 }, ctx), /Resulting content exceeds/);
  assert.equal(fs.readFileSync(path.join(workspace, 'full.txt'), 'utf8'), full);
});

test('missing handoff credentials surface immediately in results, disable the catalog, and block retries', async (t) => {
  const { workspace, config } = fixture(t);
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 123;
  let spawns = 0;
  const runtime = loadBridge('handoff.js', { child_process: {
    spawnSync: () => ({ status: 0 }), spawn: () => { spawns++; return child; },
  } });
  config.dshBin = __filename;
  const manager = new runtime.HandoffManager(config);
  assert.equal(manager.availability().credentialStatus, 'unverified');
  const started = manager.start({ workspace, planText: 'Test plan' });
  t.after(() => clearTimeout(manager.runs.get(started.runId).timer));
  child.stderr.emit('data', Buffer.from('dsh: MISSING_CREDENTIAL: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY'));
  child.emit('close', 1);
  const result = manager.get(started.runId);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'E_MISSING_CREDENTIAL');
  assert.match(result.error.message, /DEEPSEEK_API_KEY/);
  assert.ok(result.stderrFile);
  assert.equal(manager.availability().available, false);
  assert.throws(() => manager.start({ workspace, planText: 'Retry' }), (error) => error.code === 'E_MISSING_CREDENTIAL');
  assert.equal(spawns, 1);

  const server = loadBridge('server.js', {
    './guard': { ...guard, loadConfig: () => config },
    './handoff': { HandoffManager: class { constructor() { return manager; } }, dshProbe: runtime.dshProbe },
    http: { createServer: () => ({ listen() {} }) },
    fs: { ...fs, appendFileSync() {} },
  }, '\nmodule.exports = { handle };');
  const tools = await server.handle({}, {}, '/tools', null);
  assert.equal(tools.tools.some((tool) => tool.name === 'dsh_handoff'), false);
  const health = await server.handle({}, {}, '/health', null);
  assert.equal(health.dsh.credentialStatus, 'missing');
  assert.equal(health.dsh.binFound, true);
  assert.equal(health.dsh.available, false);
  assert.equal(health.toolCount, tools.tools.length);
});

test('npm dsh.cmd resolves the package JavaScript entry before launching a handoff', (t) => {
  const { workspace, config } = fixture(t);
  const packageDir = path.join(workspace, 'node_modules', '@deepseek-ai', 'dsh');
  fs.mkdirSync(path.join(packageDir, 'lib'), { recursive: true });
  const bin = path.join(packageDir, 'lib', 'bin.js');
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ bin: { dsh: 'lib/bin.js' } }));
  fs.writeFileSync(bin, 'console.log("fixture")');
  config.dshBin = path.join(workspace, 'dsh.cmd');
  fs.writeFileSync(config.dshBin, '@echo off\r\n');
  let spawned;
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 123;
  const runtime = loadBridge('handoff.js', { child_process: { spawnSync: () => ({ status: 0 }), spawn: (exe, args) => { spawned = { exe, args }; return child; } } });
  assert.equal(runtime.resolveDshBin(config), bin);
  const manager = new runtime.HandoffManager(config);
  const run = manager.start({ workspace, planText: 'Fixture only', timeoutMs: 30000 });
  t.after(() => clearTimeout(manager.runs.get(run.runId).timer));
  assert.equal(spawned.args[0], bin);
  assert.notEqual(spawned.args[0], config.dshBin);
});

test('health identifies the loaded build and shutdown rejects active work', async (t) => {
  const { config } = fixture(t);
  let finish;
  const server = loadBridge('server.js', {
    './guard': { ...guard, loadConfig: () => config },
    './handoff': { HandoffManager: class {}, dshProbe: () => ({ binFound: false }) },
    './tools': { TOOL_DEFS, runTool: () => new Promise((resolve) => { finish = resolve; }) },
    http: { createServer: () => ({ listen() {} }) },
    fs: { ...fs, appendFileSync() {} },
  }, '\nmodule.exports = { handle, handoff };');
  const running = server.handle({}, {}, '/tool', { tool: 'dsh_read', args: {} });
  const health = await server.handle({}, {}, '/health', null);
  assert.match(health.buildId, /^[0-9a-f]{64}$/);
  assert.equal(health.toolCount, TOOL_DEFS.length);
  assert.equal(health.activeTools, 1);
  await assert.rejects(server.handle({ method: 'POST' }, {}, '/shutdown', null), (error) => error.code === 'E_BUSY');
  finish({}); await running;
  server.handoff.current = { runId: 'busy-handoff' };
  await assert.rejects(server.handle({ method: 'POST' }, {}, '/shutdown', null), (error) => error.code === 'E_BUSY');
});
