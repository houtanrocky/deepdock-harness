const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { runTool, runCaptured, TOOL_DEFS } = require('../../bridge/tools');
const guard = require('../../bridge/guard');

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-'));
  t.after(() => {
    assert.equal(path.dirname(workspace), os.tmpdir());
    assert.ok(path.basename(workspace).startsWith('dsh-runtime-'));
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  const config = { token: 'fixture-only-token'.padEnd(64, '0'), allowedRoots: [workspace], bashTimeoutMs: 20000, bashTimeoutMaxMs: 120000 };
  return { workspace, config };
}

function loadBridge(filename, overrides, suffix = '', platform = process.platform) {
  const file = path.resolve(__dirname, '../../bridge', filename);
  const localRequire = createRequire(file);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + suffix, {
    require: (name) => Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name),
    module, __dirname: path.dirname(file), Buffer, setTimeout, clearTimeout,
    console: { log() {}, error() {} }, process: { env: process.env, platform, on() {} },
  }, { filename: file });
  return module.exports;
}

test('the authenticated instruction route shares guarded discovery and advertises its capability', async (t) => {
  const { workspace, config } = fixture(t);
  fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'Project guidance');
  const server = loadBridge('server.js', {
    './guard': { ...guard, loadConfig: () => config },
    './handoff': { HandoffManager: class {}, dshProbe: () => ({ binFound: false }) },
    http: { createServer: () => ({ listen() {} }) },
    fs: { ...fs, appendFileSync() {} },
  }, '\nmodule.exports = { handle };');
  const health = await server.handle({}, {}, '/health');
  assert.equal(health.capabilities.projectInstructions, true);
  const response = await server.handle({}, {}, '/instructions', { workspace, paths: ['new.js'] });
  assert.equal(response.data.instructions[0].content, 'Project guidance');
  await assert.rejects(server.handle({}, {}, '/instructions', { workspace, paths: ['../outside'] }), (error) => error.code === 'E_PATH_ESCAPE');
});

test('large command output supplies an exact workspace-relative read and a line-readable report', async (t) => {
  const { workspace, config } = fixture(t);
  fs.mkdirSync(path.join(workspace, 'project'));
  const report = Array.from({ length: 1200 }, (_, index) => `Review line ${index + 1}: actual report details and acceptance criteria.`).join('\n');
  const server = loadBridge('server.js', {
    './guard': { ...guard, loadConfig: () => config },
    './handoff': { HandoffManager: class {}, dshProbe: () => ({ binFound: false }) },
    './tools': { TOOL_DEFS, runTool: (name, args, ctx) => name === 'dsh_bash' ? { stdout: report, stderr: '', exitCode: 0, shell: 'cmd.exe', logFile: '.dsh-pro/logs/execution-log.jsonl' } : runTool(name, args, ctx) },
    http: { createServer: () => ({ listen() {} }) },
    fs: { ...fs, appendFileSync() {} },
  }, '\nmodule.exports = { handle };');
  const response = await server.handle({}, {}, '/tool', { tool: 'dsh_bash', args: { command: 'cd project && git show HEAD:REVIEW.md' }, workspace });
  const data = response.data;
  assert.equal(data.fullOutputWorkspace, workspace);
  assert.equal(data.readWith.args.workspace, workspace);
  assert.equal(data.readWith.tool, 'dsh_read');
  assert.match(data.readWith.args.path, /^\.dsh-pro\/outputs\/.*\.stdout\.txt$/);
  assert.equal(data.exitCode, 0);
  assert.equal(fs.readFileSync(path.join(workspace, data.textOutputFile), 'utf8'), report);
  assert.equal(JSON.parse(fs.readFileSync(path.join(workspace, data.fullOutputFile), 'utf8')).stdout, report);
  const legacyPage = await runTool('dsh_read', { path: data.fullOutputFile, jsonField: 'stdout', offset: 81, limit: 80 }, { config, workspace });
  assert.equal(legacyPage.jsonField, 'stdout');
  assert.match(legacyPage.content, /Review line 81:/);
  assert.match(legacyPage.content, /Review line 160:/);
  assert.doesNotMatch(legacyPage.content, /Review line 1:/);
  const rawPage = await runTool('dsh_read', { path: data.fullOutputFile, offset: 1, limit: 1 }, { config, workspace });
  assert.equal(legacyPage.sha256, rawPage.sha256);
  await assert.rejects(runTool('dsh_read', { path: data.fullOutputFile, jsonField: '__proto__' }, { config, workspace }), (error) => error.code === 'E_ARGS_INVALID');
  assert.equal(fs.existsSync(path.join(workspace, 'project', data.textOutputFile)), false);
  const read = await server.handle({}, {}, '/tool', { ...data.readWith, workspace: data.readWith.args.workspace });
  assert.equal(read.ok, true);
  assert.match(read.data.content, /Review line 1:/);
  assert.match(read.data.content, /Review line 80:/);
  assert.equal(read.data.fullOutputFile, undefined, 'Reading a normal page of the report must not spool another JSON output');
  await assert.rejects(runTool('dsh_read', { path: '../' + data.fullOutputFile }, { config, workspace }), (error) => error.code === 'E_PATH_ESCAPE');
});

test('a timed-out process returns captured output and confirmed termination', async (t) => {
  const { workspace } = fixture(t);
  const result = await runCaptured(process.execPath, ['-e', 'process.stdout.write("partial report\\n"); process.stderr.write("diagnostic\\n"); setInterval(() => {}, 1000);'], workspace, 1000, 8192);
  assert.equal(result.timedOut, true);
  assert.equal(result.terminationConfirmed, true);
  assert.match(result.stdout, /partial report/);
  assert.match(result.stderr, /diagnostic/);
});

test('Windows timeout cleanup stays responsive and bounded when taskkill never finishes', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 123;
  let killRequested = false;
  child.kill = () => { killRequested = true; return true; };
  const killer = new EventEmitter();
  const calls = [];
  const runtime = loadBridge('tools.js', { child_process: {
    spawn(executable, args, options) { calls.push({ executable, args, options }); return executable === 'taskkill' ? killer : child; },
    spawnSync() { throw new Error('Timeout cleanup must not invoke synchronous taskkill'); },
  } }, '', 'win32');
  let ticks = 0;
  const heartbeat = setInterval(() => { ticks++; }, 20);
  const start = Date.now();
  try {
    const pending = runtime.runCaptured('fixture-command', [], '.', 10, 8192);
    child.stdout.write('captured partial output');
    const result = await pending;
    assert.ok(Date.now() - start < 5000);
    assert.ok(ticks > 5, 'Bridge callbacks must remain responsive during process cleanup');
    assert.equal(result.timedOut, true);
    assert.equal(result.terminationConfirmed, false);
    assert.match(result.stdout, /captured partial output/);
    assert.equal(killRequested, true);
    const taskkill = calls.find((call) => call.executable === 'taskkill');
    assert.deepEqual(Array.from(taskkill.args), ['/PID', '123', '/T', '/F']);
    assert.equal(taskkill.options.windowsHide, true);
    assert.ok(taskkill.options.timeout <= 3000);
  } finally { clearInterval(heartbeat); }
});

test('shell timeout errors retain partial output and cleanup state in structured diagnostics', async (t) => {
  const { workspace, config } = fixture(t);
  const command = `"${process.execPath}" -e "process.stdout.write('partial report');setInterval(() => {}, 1000)"`;
  await assert.rejects(runTool('dsh_bash', { command, timeoutMs: 1000 }, { config, workspace, permissionMode: 'full' }), (error) => {
    assert.equal(error.code, 'E_TIMEOUT');
    assert.equal(error.extra.timeoutMs, 1000);
    assert.equal(error.extra.timedOut, true);
    assert.equal(error.extra.terminationConfirmed, true);
    assert.match(error.extra.stdout, /partial report/);
    return true;
  });
});
