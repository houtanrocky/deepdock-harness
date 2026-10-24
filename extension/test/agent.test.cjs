'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBackground } = require('../src/background.js');
const { createHarness } = require('../src/harness.js');
const { randomUUID } = require('node:crypto');
const { protocol } = require('../src/core/protocol.js');
const { TOOL_DEFS } = require('../../bridge/tools');
const plain = (value) => JSON.parse(JSON.stringify(value));
const call = (tool, args = {}) => protocol.OPEN + JSON.stringify({ tool, args }) + protocol.CLOSE;
const url = 'https://chat.deepseek.com/a/chat/s/test';
const dsml = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="bash">\n<｜｜DSML｜｜ parameter name="command" string="true">powershell -Command "Get-ChildItem | Where-Object { _.FullName -notmatch nodemodules }"</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';

function backgroundHarness(options = {}) {
  const local = {};
  const session = {};
  const requests = [];
  let listener;
  function storage(data) {
    return {
      async get(keys) {
        if (typeof keys === 'string') return plain({ [keys]: data[keys] });
        if (Array.isArray(keys)) return plain(Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]])));
        return plain({ ...keys, ...data });
      },
      async set(entries) { Object.assign(data, plain(entries)); },
      async remove(key) { delete data[key]; },
    };
  }
  const chrome = {
    storage: { local: storage(local), session: storage(session) },
    alarms: { onAlarm: { addListener() {} }, async create() {}, async clear() {} },
    runtime: {
      onMessage: { addListener(callback) { listener = callback; } },
      sendMessage(msg, tabId = 1) {
        return new Promise((resolve) => listener(plain(msg), { tab: { id: tabId } }, (result) => resolve(plain(result))));
      },
    },
  };
  startBackground(chrome, { setTimeout: options.setTimeout || setTimeout, clearTimeout, fetch: async (target, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ target, body, method: init.method });
    if (options.fetch) return options.fetch(target, init);
    return { ok: true, status: 200, async json() { return { ok: true, data: { content: 'tool result' } }; } };
  } });
  return { chrome, local, session, requests };
}

function contentHarness(responses = [], options = {}) {
  const background = backgroundHarness(options);
  const nodes = new Map();
  for (const id of ['dshpro-log', 'dshpro-phase', 'dshpro-dot', 'dshpro-loops', 'dshpro-resume', 'dshpro-workspace', 'dshpro-parser-error', 'dshpro-confirm', 'dshpro-confirm-text', 'dshpro-confirm-yes', 'dshpro-confirm-no']) nodes.set(id, { textContent: '', style: {}, appendChild() {}, querySelector() { return this; } });
  const ports = {};
  const api = createHarness({ browser: background.chrome, ports, platform: {
    document: { getElementById: (id) => nodes.get(id) || null, createElement: () => ({}) },
    location: new URL(url), AbortController, crypto: { randomUUID },
    setTimeout, clearTimeout, setInterval, clearInterval, console,
  } });
  const sent = [];
  api.state.tools = { tools: TOOL_DEFS };
  api.state.health = { allowedRoots: ['C:/workspace'], dsh: { binFound: true } };
  api.state.enabled = true;
  ports.send = async (text, run) => {
    if (run.controller.signal.aborted) throw Object.assign(new Error('Task stopped'), { code: 'E_STOPPED' });
    sent.push(text);
    const raw = responses.shift();
    if (raw === undefined) throw new Error('No fixture response available');
    return { promise: Promise.resolve({ raw, ...(options.completion ? { completion: options.completion } : {}) }), cancel() {} };
  };
  return { ...api, ...background, nodes, sent, setTransport: (fn) => { ports.send = fn; }, setBridge: (fn) => { ports.bridge = fn; }, saved: () => background.local['dshpro:conversation:' + url] };
}

test('strict JSON preserves code, escapes, and literal protocol markers', () => {
  const content = '<a href="link">\n</a>\nconst r = /\\s+/;\n' + protocol.CLOSE + '\n[判定] data <ds_safety>literal</ds_safety>';
  const parsed = protocol.parse(call('dsh_write', { path: 'a.html', content }));
  assert.deepEqual(parsed.calls[0].args, { path: 'a.html', content });
  assert.equal(parsed.repaired, false);
  assert.equal(parsed.errors.length, 0);
});

test('repair escapes literal newlines and unescaped HTML/JS quotes before parsing', () => {
  const code = '<a href="link">Hello</a>\n<script>console.log("ok");</script>';
  const raw = '{"tool":"dsh_write","args":{"path":"a.html","content":"' + code + '"}}';
  const parsed = protocol.parse(protocol.OPEN + raw + protocol.CLOSE);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.repaired, true);
  assert.equal(parsed.calls[0].args.content, code);
});

test('raw arguments preserve complex code without escaping and reject duplicate keys', () => {
  const code = '\n<a href="link">\n\\path\\to\\file\n' + protocol.CLOSE + '\n';
  const block = protocol.OPEN + '\n{"tool":"dsh_write","args":{"path":"a.html"}}\n⟦DSH:ARG:content⟧\n' + code + '\n⟦/DSH:ARG:content⟧\n' + protocol.CLOSE;
  const parsed = protocol.parse(block);
  assert.equal(parsed.calls[0].args.content, code);
  assert.equal(parsed.errors.length, 0);
  assert.equal(protocol.parse(block.replace('"path":"a.html"', '"path":"a.html","content":"duplicate"')).errors.length, 1);
});

test('repair handles the reported HTML with mixed escaped and unescaped attribute quotes', () => {
  const raw = String.raw`{"tool":"dsh_write","args":{"path":"maktab-sharif-landing/index.html","content":"<!DOCTYPE html>\n<html lang="en">\n<meta charset="UTF-8" />\n<link rel="preconnect" href="https://fonts.googleapis.com\" />\n<a href="#team" class="btn">Team</a>\n<script src="script.js"></script>\n</html>\n"}}`;
  const parsed = protocol.parse(protocol.OPEN + raw + protocol.CLOSE);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.repaired, true);
  assert.equal(parsed.calls[0].args.content, '<!DOCTYPE html>\n<html lang="en">\n<meta charset="UTF-8" />\n<link rel="preconnect" href="https://fonts.googleapis.com" />\n<a href="#team" class="btn">Team</a>\n<script src="script.js"></script>\n</html>\n');
});

test('both leading safety formats and tag case variants are stripped without modifying payloads', () => {
  for (const prefix of ['<ds_safety>review\ntext</ds_safety>', '<DS-SAFETY>review</DS-SAFETY>', '[用户未成年]否\n[分类]其他\n[判定]review\n\n', '[用户未成年]否\n[分类]其他\n[判定]review']) {
    const parsed = protocol.parse(prefix + call('dsh_read', { path: 'actual.txt' }));
    assert.equal(parsed.calls[0].args.path, 'actual.txt');
    assert.equal(parsed.errors.length, 0);
  }
});

test('malformed, incomplete, unknown, and excessive calls are explicit failures', () => {
  const raw = '{"tool":"dsh_write","args":{"content":BROKEN}}';
  assert.equal(protocol.parse(protocol.OPEN + raw + protocol.CLOSE).errors[0].raw, raw);
  assert.equal(protocol.parse(protocol.OPEN + '{}').errors.length, 1);
  assert.equal(protocol.parse(call('unknown'), { knownTools: ['dsh_read'] }).errors.length, 1);
  assert.equal(protocol.parse(Array(4).fill(call('dsh_read')).join('\n')).errors.length, 1);
  const markerLiterals = protocol.OPEN + '{"tool":"dsh_write","args":{"content":BROKEN ' + protocol.OPEN.repeat(5) + '}}' + protocol.CLOSE;
  const rejected = protocol.parse(markerLiterals);
  assert.equal(rejected.errors.length, 1);
  assert.doesNotMatch(rejected.errors[0].message, /Too many calls/);
});

test('five valid read calls recover as a limit error without executing any rejected calls', async () => {
  const paths = ['Notification.java', 'NotificationEmailService.java', 'NotificationSmsService.java', 'DiscountPercentageStrategy.java', 'DiscountNoDiscountStrategy.java']
    .map((file) => 'demo14/src/main/java/com/eduStream/service/' + file);
  const reads = paths.map((path) => call('dsh_read', { path }));
  const rejected = reads.join('\n');
  assert.equal(protocol.parse(rejected).errors[0].code, 'E_TOO_MANY_CALLS');
  const h = contentHarness([call('dsh_read', { path: 'already-read.txt' }), rejected, ...reads, 'Read all five files.']);
  await h.startRun({ task: 'Inspect the notification and discount services' });
  assert.equal(h.saved().stage, 'completed');
  assert.deepEqual(h.requests.map((request) => request.body.args.path), ['already-read.txt', ...paths]);
  assert.match(h.sent[2], /exceeded the tool-call limit \(3 per response\)/);
  assert.match(h.sent[2], /No calls from that rejected response executed, including the first 3/);
  assert.doesNotMatch(h.sent[2], /Your JSON was malformed/);
  assert.equal(h.saved().conversationHistory.find((entry) => entry.parseErrors?.length).raw, rejected);
});

test('successful JSON repair guides the next turn toward raw arguments without retrying the action', async () => {
  const code = '<a href="link">Hello</a>\n<script>console.log("ok");</script>';
  const malformed = protocol.OPEN + '{"tool":"dsh_write","args":{"path":"a.html","content":"' + code + '"}}' + protocol.CLOSE;
  const h = contentHarness([malformed, call('dsh_read', { path: 'a.html' }), 'Written and verified.']);
  await h.startRun({ task: 'Write and verify the page' });
  assert.equal(h.saved().stage, 'completed');
  assert.deepEqual(h.requests.map((request) => request.body.tool), ['dsh_write', 'dsh_read']);
  assert.equal(h.requests[0].body.args.content, code);
  assert.match(h.sent[1], /previous tool JSON required automatic repair/);
  assert.match(h.sent[1], /use raw argument blocks inside a fenced text code block/);
  assert.doesNotMatch(h.sent[2], /previous tool JSON required automatic repair/);
  assert.equal(h.saved().retryCount, 0);
  assert.equal(h.saved().conversationHistory.some((entry) => entry.kind === 'parse-error'), false);
  assert.equal(h.saved().conversationHistory.find((entry) => entry.repaired).raw, malformed);
});

test('native DSML is rejected atomically while literal markup inside DSH arguments remains data', () => {
  for (const raw of [dsml, dsml.replaceAll('｜', '|'), '<DSML><invoke name="bash">echo example</invoke></DSML>', '<function_calls><invoke name="bash">echo example</invoke></function_calls>', '<｜DSML｜invoke name="bash">', '<｜｜DS', '<|', '```text\n<｜DS\n```', call('dsh_read', { path: 'must-not-run.txt' }) + dsml, 'DSH:DONE:finished\n' + dsml]) {
    const parsed = protocol.parse(raw);
    assert.ok(parsed.errors.some((error) => error.code === 'E_UNSUPPORTED_TOOL_FORMAT'));
    assert.equal(parsed.done, null);
  }
  for (const raw of [call('dsh_write', { path: 'example.txt', content: dsml }), `${protocol.OPEN}\n{"tool":"dsh_write","args":{"path":"example.txt"}}\n⟦DSH:ARG:content⟧\n${dsml}\n⟦/DSH:ARG:content⟧\n${protocol.CLOSE}`]) {
    const parsed = protocol.parse(raw);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.calls[0].args.content, dsml);
  }
});

test('command failures followed by DSML recover without executing or repairing the damaged command', async () => {
  const h = contentHarness([call('dsh_bash', { command: 'broad search' }), call('dsh_bash', { command: 'narrow search' }), dsml, call('dsh_read', { path: 'review/README.md' }), 'Review read.']);
  const seen = [];
  h.setBridge(async (method, route, body) => {
    seen.push(body);
    if (body.tool === 'dsh_bash') return { status: 422, json: { ok: false, error: { code: seen.length === 1 ? 'E_TIMEOUT' : 'E_COMMAND_FAILED', message: 'Search failed', extra: { stdout: 'main.go', exitCode: 1 } } } };
    return { status: 200, json: { ok: true, data: { content: 'Review contents' } } };
  });
  await h.startRun({ task: 'Read the review report' });
  assert.equal(h.saved().stage, 'completed');
  assert.deepEqual(seen.map((request) => request.tool), ['dsh_bash', 'dsh_bash', 'dsh_read']);
  assert.match(h.sent[3], /unsupported native DSML/);
  assert.match(h.sent[3], /For commands use dsh_bash, not bash/);
  assert.match(h.sent[3], /Do not translate or execute the damaged DSML parameter text automatically/);
});

test('repeated native markup pauses instead of silently completing, and legacy completion can be resumed', async () => {
  const h = contentHarness([dsml, dsml, dsml]);
  await h.startRun({ task: 'Continue reading the report' });
  assert.equal(h.saved().stage, 'error');
  assert.equal(h.saved().inProgress, true);
  assert.equal(h.requests.length, 0);
  const resumed = contentHarness([call('dsh_read', { path: 'review.txt' }), 'Report read.']);
  resumed.local['dshpro:conversation:' + url] = { revision: 0, iterationCount: 3, stage: 'completed', inProgress: false, conversationHistory: [{ role: 'user', content: 'Read the report' }, { role: 'assistant', content: dsml, raw: dsml, tool_calls: [], parseErrors: [] }] };
  await resumed.startRun({ resume: true });
  assert.equal(resumed.saved().stage, 'completed');
  assert.deepEqual(resumed.requests.map((request) => request.body.tool), ['dsh_read']);
});

test('a saved-output path escape receives the original workspace and exact read call', async () => {
  const readWith = { tool: 'dsh_read', args: { workspace: 'C:/workspace', path: '.dsh-pro/outputs/review.stdout.txt', offset: 1, limit: 80 } };
  const h = contentHarness([call('dsh_bash', { command: 'cd project && git show HEAD:REVIEW.md' }), call('dsh_read', { path: '../.dsh-pro/outputs/review.json' }), dsml, call(readWith.tool, readWith.args), 'Read the report.']);
  const seen = [];
  h.setBridge(async (method, route, body) => {
    seen.push(body);
    if (body.tool === 'dsh_bash') return { status: 200, json: { ok: true, data: { fullOutputFile: '.dsh-pro/outputs/review.json', fullOutputWorkspace: 'C:/workspace', readWith } } };
    if (body.args.path.startsWith('../')) return { status: 403, json: { ok: false, error: { code: 'E_PATH_ESCAPE', message: 'Path escapes the workspace root' } } };
    return { status: 200, json: { ok: true, data: { content: 'Actual review report' } } };
  });
  await h.startRun({ task: 'Read the full review report' });
  assert.equal(h.saved().stage, 'completed');
  assert.deepEqual(seen.map((request) => request.tool), ['dsh_bash', 'dsh_read', 'dsh_read']);
  const recovery = h.saved().conversationHistory.find((entry) => entry.kind === 'tool-recovery');
  assert.match(recovery.content, /relative to its bridge workspace/);
  assert.ok(recovery.content.includes(JSON.stringify(readWith)));
  assert.deepEqual(seen[2].args, readWith.args);
});

test('task loop sends full history, executes sequentially, records results, and ends on ordinary prose', async () => {
  const h = contentHarness([call('dsh_read', { path: 'a.txt' }) + '\n' + call('dsh_read', { path: 'b.txt' }), 'Finished the task.']);
  await h.startRun({ task: 'Read both files' });
  const saved = h.saved();
  assert.equal(saved.stage, 'completed');
  assert.equal(saved.inProgress, false);
  assert.equal(saved.iterationCount, 2);
  assert.deepEqual(h.requests.map((request) => request.body.args.path), ['a.txt', 'b.txt']);
  assert.deepEqual(saved.conversationHistory.map((entry) => entry.role), ['user', 'assistant', 'system', 'tool', 'system', 'tool', 'assistant']);
  assert.match(h.sent[1], /tool result/);
  assert.match(h.sent[1], /Read both files/);
});

test('write parse failures request small chunks; a third pauses with exact raw JSON visible', async () => {
  const raw = '{"tool":"dsh_write","args":{"content":BROKEN' + 'x'.repeat(550) + '}}';
  const invalid = protocol.OPEN + raw + protocol.CLOSE;
  const h = contentHarness([invalid, invalid, invalid]);
  await h.startRun({ task: 'Generate a landing page' });
  assert.equal(h.saved().retryCount, 3);
  assert.equal(h.saved().stage, 'error');
  assert.equal(h.requests.length, 0);
  assert.match(h.sent[1], /\[DeepDock Harness System\] Your JSON was malformed\. Error:/);
  assert.match(h.sent[2], /chunk below 1.5 KB/);
  assert.match(h.sent[2], /Do not switch to handoff to repair framing errors/);
  assert.doesNotMatch(h.sent[2], /Please use dsh_handoff/);
  assert.match(h.sent[2], /Rejected output excerpt/);
  assert.ok(h.nodes.get('dshpro-parser-error').textContent.includes(raw));
});

test('mixed valid/invalid calls execute nothing until the model corrects the whole turn', async () => {
  const h = contentHarness([call('dsh_read', { path: 'do-not-run.txt' }) + protocol.OPEN + '{broken}' + protocol.CLOSE, 'No action needed.']);
  await h.startRun({ task: 'Task' });
  assert.equal(h.requests.length, 0);
  assert.equal(h.saved().stage, 'completed');
});

test('hard iteration cap and explicit Stop leave a resumable checkpoint without replaying tools', async () => {
  const h = contentHarness([call('dsh_read', { path: 'a.txt' })]);
  h.state.loopLimit = 1;
  await h.startRun({ task: 'Task' });
  assert.equal(h.saved().iterationCount, 1);
  assert.equal(h.saved().stage, 'error');
  assert.equal(h.saved().inProgress, true);
  assert.equal(h.requests.length, 1);
  const paused = contentHarness();
  paused.setTransport(async (text, run) => ({ promise: new Promise((resolve, reject) => run.controller.signal.addEventListener('abort', () => reject(Object.assign(new Error('Stopped'), { code: 'E_STOPPED' })), { once: true })) }));
  const running = paused.startRun({ task: 'Task' });
  await new Promise(setImmediate);
  await paused.doStop(); await running;
  assert.equal(paused.saved().stage, 'stopped');
  assert.equal(paused.state.run, null);
});

test('handshake accepts English without executing echoed calls and then supports reload resume', async () => {
  const h = contentHarness(['Protocol understood\n' + call('dsh_read', { path: 'example.txt' })]);
  await h.startRun({ handshake: true });
  assert.equal(h.requests.length, 0);
  assert.equal(h.state.enabled, true);
  assert.equal(h.saved().stage, 'ready');
  assert.doesNotMatch(h.buildProtocolMessage(), /\p{Script=Han}/u);
});

test('persistent background rejects competing tabs and stale revisions, and isolates conversation URLs', async () => {
  const h = backgroundHarness();
  const send = (body, tab = 1) => h.chrome.runtime.sendMessage({ url, ...body }, tab);
  assert.equal((await send({ type: 'conversationClaim', runId: 'first' })).ok, true);
  assert.equal((await send({ type: 'conversationClaim', runId: 'second' }, 2)).ok, false);
  const data = { conversationHistory: [{ role: 'user', content: 'Task' }], iterationCount: 3, revision: 0, inProgress: true };
  assert.equal((await send({ type: 'conversationSave', runId: 'first', data })).revision, 1);
  assert.equal((await send({ type: 'conversationSave', runId: 'first', data })).ok, false);
  assert.equal((await send({ type: 'conversationLoad' })).data.iterationCount, 3);
  assert.equal((await send({ type: 'conversationLoad', url: url + '-other' })).data.iterationCount, 0);
  await send({ type: 'conversationRelease', runId: 'first' });
  assert.equal((await send({ type: 'conversationClaim', runId: 'second' }, 2)).ok, true);
});

test('resume reattaches to the saved handoff and appends its result without starting it again', async () => {
  const h = contentHarness(['Finished after handoff.']);
  h.local['dshpro:conversation:' + url] = {
    conversationHistory: [{ role: 'system', kind: 'tool-intent', tool: 'dsh_handoff', tool_call_id: 'original-call' }],
    iterationCount: 3, retryCount: 0, writeFailures: 0, revision: 0, inProgress: true, handoffRunId: 'remote',
  };
  const send = h.chrome.runtime.sendMessage;
  h.chrome.runtime.sendMessage = (msg) => msg.type === 'handoffStatus' ? Promise.resolve({ ok: true, status: 200, json: { run: { runId: 'remote', status: 'done', exitCode: 0, stdout: 'Built it' } } }) : send(msg);
  await h.startRun({ resume: true });
  assert.equal(h.requests.length, 0);
  const results = h.saved().conversationHistory.filter((entry) => entry.role === 'tool');
  assert.equal(results.length, 1);
  assert.equal(results[0].tool_call_id, 'original-call');
  assert.equal(h.saved().iterationCount, 4);
  assert.equal(h.saved().handoffRunId, null);
});

test('allow-once sends the bridge confirmation token; deny never retries the operation', async () => {
  for (const allowed of [true, false]) {
    const h = contentHarness([call('dsh_bash', { command: 'echo hello' }), 'Finished.']);
    const bridgeCalls = [];
    h.setBridge(async (method, target, body) => {
      bridgeCalls.push(body);
      return { status: body.confirmToken ? 200 : 403, json: body.confirmToken ? { ok: true, data: { stdout: 'hello' } } :
        { ok: false, error: { code: 'E_NEEDS_CONFIRM', message: 'Confirm command', extra: { confirmToken: 'test-token' } } } };
    });
    const pending = h.startRun({ task: 'Run command' });
    await new Promise(setImmediate);
    h.nodes.get(allowed ? 'dshpro-confirm-yes' : 'dshpro-confirm-no').onclick();
    await pending;
    assert.equal(bridgeCalls.length, allowed ? 2 : 1);
    if (allowed) assert.equal(bridgeCalls[1].confirmToken, 'test-token');
    const result = h.saved().conversationHistory.find((entry) => entry.role === 'tool').result;
    assert.equal(result.ok, allowed);
    if (!allowed) assert.equal(result.error.code, 'E_USER_DENIED');
  }
});

test('Stop records the result of an already accepted tool and never sends another turn', async () => {
  const h = contentHarness([call('dsh_read', { path: 'a.txt' })]);
  let resolveTool;
  h.setBridge(() => new Promise((resolve) => { resolveTool = resolve; }));
  const pending = h.startRun({ task: 'Read file' });
  await new Promise(setImmediate);
  const stopped = h.doStop();
  resolveTool({ status: 200, json: { ok: true, data: { content: 'already executed' } } });
  await stopped; await pending;
  assert.equal(h.saved().stage, 'stopped');
  assert.equal(h.saved().conversationHistory.filter((entry) => entry.role === 'tool').length, 1);
  assert.equal(h.sent.length, 1);
});

test('a newly created chat migrates its history and lease from the blank chat URL', async () => {
  const h = backgroundHarness();
  const original = 'https://chat.deepseek.com/';
  await h.chrome.runtime.sendMessage({ type: 'conversationClaim', url: original, runId: 'new-chat' });
  const data = { conversationHistory: [{ role: 'user', content: 'Task' }], iterationCount: 1, revision: 0 };
  await h.chrome.runtime.sendMessage({ type: 'conversationSave', url: original, runId: 'new-chat', data });
  data.revision = 1;
  const moved = await h.chrome.runtime.sendMessage({ type: 'conversationMove', url: original, destination: url, runId: 'new-chat', data });
  assert.equal(moved.revision, 2);
  assert.equal(h.local['dshpro:conversation:' + url].conversationHistory[0].content, 'Task');
  assert.equal(h.local['dshpro:conversation:' + original], undefined);
});

test('bridge retries transient reads but never retries HTTP authorization failures', async () => {
  let attempts = 0;
  const h = backgroundHarness({ fetch: async () => {
    if (++attempts < 3) throw new TypeError('Failed to fetch');
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  } });
  const recovered = await h.chrome.runtime.sendMessage({ type: 'bridge', path: '/health' });
  assert.equal(recovered.ok, true);
  assert.equal(h.requests.length, 3);
  const unauthorized = backgroundHarness({ fetch: async () => ({ ok: false, status: 401, json: async () => ({ ok: false, error: { message: 'Incorrect token' } }) }) });
  assert.equal((await unauthorized.chrome.runtime.sendMessage({ type: 'bridge', path: '/health' })).status, 401);
  assert.equal(unauthorized.requests.length, 1);
});

test('read timeouts are bounded and identify the failing bridge endpoint', async () => {
  const h = backgroundHarness({
    setTimeout: (callback) => setTimeout(callback, 0),
    fetch: (target, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  const response = await h.chrome.runtime.sendMessage({ type: 'bridge', path: '/health' });
  assert.equal(h.requests.length, 3);
  assert.equal(response.status, 0);
  assert.match(response.error, /GET http:\/\/127\.0\.0\.1:8765\/health/);
  assert.match(response.error, /Timed out after 5 seconds/);
});

test('lost tool responses pause, mark the bridge disconnected, and never replay the POST', async () => {
  const h = contentHarness([call('dsh_write', { path: 'a.txt', content: 'hello' })], {
    fetch: async () => { throw new TypeError('Failed to fetch'); },
  });
  h.state.connected = true;
  await h.startRun({ task: 'Write a file' });
  assert.equal(h.requests.length, 1);
  assert.equal(h.state.connected, false);
  assert.equal(h.saved().inProgress, true);
  const result = h.saved().conversationHistory.find((entry) => entry.role === 'tool').result;
  assert.equal(result.error.code, 'E_BRIDGE_UNREACHABLE');
  assert.match(result.error.message, /POST http:\/\/127\.0\.0\.1:8765\/tool/);
  assert.match(result.error.message, /may have executed; inspect the workspace/);
});

test('Resume rechecks a previously healthy bridge and leaves the checkpoint intact on failure', async () => {
  const h = contentHarness([], { fetch: async () => { throw new TypeError('Failed to fetch'); } });
  h.state.connected = true;
  const checkpoint = { conversationHistory: [{ role: 'user', content: 'Keep this task' }], iterationCount: 4, inProgress: true, revision: 1 };
  h.local['dshpro:conversation:' + url] = checkpoint;
  await h.doResume();
  assert.equal(h.state.connected, false);
  assert.equal(h.sent.length, 0);
  assert.deepEqual(h.saved(), checkpoint);
  assert.match(h.nodes.get('dshpro-phase').textContent, /^Paused: Local bridge request failed/);
});

test('a handoff status outage preserves the run for resume without cancelling or relaunching it', async () => {
  const h = contentHarness(['Finished after reconnecting.']);
  h.local['dshpro:conversation:' + url] = {
    conversationHistory: [{ role: 'system', kind: 'tool-intent', tool: 'dsh_handoff', tool_call_id: 'original-call' }],
    iterationCount: 3, revision: 0, inProgress: true, handoffRunId: 'remote',
  };
  const send = h.chrome.runtime.sendMessage;
  let available = false;
  h.chrome.runtime.sendMessage = (msg) => msg.type === 'handoffStatus' ? Promise.resolve(available ?
    { ok: true, status: 200, json: { run: { runId: 'remote', status: 'done', exitCode: 0 } } } :
    { ok: false, status: 0, error: 'Local bridge unavailable' }) : send(msg);
  await h.startRun({ resume: true });
  assert.equal(h.saved().handoffRunId, 'remote');
  assert.equal(h.requests.length, 0);
  available = true;
  await h.startRun({ resume: true });
  assert.equal(h.saved().stage, 'completed');
  assert.equal(h.saved().handoffRunId, null);
  assert.equal(h.requests.length, 0);
  assert.equal(h.saved().conversationHistory.filter((entry) => entry.role === 'tool').length, 1);
});

test('Full access automatically supplies bridge confirmation tokens without displaying a prompt', async () => {
  const h = contentHarness([call('dsh_bash', { command: 'echo hello' }), 'Finished.']);
  h.state.permissionMode = 'full';
  const calls = [];
  h.setBridge(async (method, target, body) => {
    calls.push(body);
    return { status: body.confirmToken ? 200 : 403, json: body.confirmToken ? { ok: true, data: {} } :
      { ok: false, error: { code: 'E_NEEDS_CONFIRM', message: 'Confirm command', extra: { confirmToken: 'auto-token' } } } };
  });
  await h.startRun({ task: 'Run a command' });
  assert.equal(h.saved().stage, 'completed');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].confirmToken, 'auto-token');
  assert.notEqual(h.nodes.get('dshpro-confirm').style.display, 'block');
});

test('Ask every time prompts before reads; denial sends no tool request', async () => {
  for (const allowed of [true, false]) {
    const h = contentHarness([call('dsh_read', { path: 'a.txt' }), 'Finished.']);
    h.state.permissionMode = 'always';
    const running = h.startRun({ task: 'Read a file' });
    await new Promise(setImmediate);
    assert.equal(h.requests.length, 0);
    assert.equal(h.nodes.get('dshpro-confirm').style.display, 'block');
    h.nodes.get(allowed ? 'dshpro-confirm-yes' : 'dshpro-confirm-no').onclick();
    await running;
    assert.equal(h.requests.length, allowed ? 1 : 0);
    assert.equal(h.saved().conversationHistory.find((entry) => entry.role === 'tool').result.ok, allowed);
  }
});

test('Ask every time prompts once when the bridge also requires confirmation', async () => {
  const h = contentHarness([call('dsh_bash', { command: 'echo hello' }), 'Finished.']);
  h.state.permissionMode = 'always';
  const calls = [];
  h.setBridge(async (method, target, body) => {
    calls.push(body);
    return { status: body.confirmToken ? 200 : 403, json: body.confirmToken ? { ok: true, data: {} } :
      { ok: false, error: { code: 'E_NEEDS_CONFIRM', message: 'Confirm command', extra: { confirmToken: 'once-token' } } } };
  });
  const running = h.startRun({ task: 'Run a command' });
  await new Promise(setImmediate);
  assert.equal(calls.length, 0);
  h.nodes.get('dshpro-confirm-yes').onclick();
  await running;
  assert.equal(h.saved().stage, 'completed');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].confirmToken, 'once-token');
  assert.equal(h.nodes.get('dshpro-confirm').style.display, 'none');
});

test('Stop cancels an Ask every time prompt before any tool executes', async () => {
  const h = contentHarness([call('dsh_write', { path: 'a.txt', content: 'hello' })]);
  h.state.permissionMode = 'always';
  const running = h.startRun({ task: 'Write a file' });
  await new Promise(setImmediate);
  await h.doStop();
  await running;
  assert.equal(h.requests.length, 0);
  assert.equal(h.saved().stage, 'stopped');
  assert.equal(h.nodes.get('dshpro-confirm').style.display, 'none');
});

test('large saved transcripts resume with a bounded prompt without changing archived code or replaying tools', async () => {
  const h = contentHarness(['Finished after inspecting the saved results.']);
  const code = '  nested: ${{ steps.deployment.outputs.page_url }}\n'.repeat(9000);
  const entries = [
    { role: 'user', content: 'Fix the workflow, then create the requested repository and push.' },
    { role: 'assistant', raw: code, content: code, tool_calls: [{ tool: 'dsh_write', args: { path: 'workflow.yml', content: code } }] },
    { role: 'system', kind: 'tool-intent', tool: 'dsh_write', tool_call_id: 'prior-write', args: { path: 'workflow.yml', content: code } },
    { role: 'tool', tool: 'dsh_write', tool_call_id: 'prior-write', result: { ok: true, data: { file: 'workflow.yml', sha256: 'original-hash' } } },
  ];
  h.local['dshpro:conversation:' + url] = { conversationHistory: entries, iterationCount: 4, revision: 0, inProgress: true };
  await h.startRun({ resume: true });
  assert.equal(h.saved().stage, 'completed');
  assert.ok(h.sent[0].length < 200000);
  assert.match(h.sent[0], /Fix the workflow, then create/);
  assert.match(h.sent[0], /prior-write/);
  assert.match(h.sent[0], /original-hash/);
  assert.deepEqual(h.saved().conversationHistory.slice(0, entries.length), entries);
  assert.equal(h.requests.length, 0);
});

test('protocol guidance follows the live catalog and runtime readiness', () => {
  const h = contentHarness();
  h.state.tools.tools = TOOL_DEFS.filter((tool) => !tool.name.startsWith('dsh_github_') && tool.name !== 'dsh_git_push');
  h.state.health.dsh.binFound = false;
  const protocolText = h.buildProtocolMessage();
  assert.doesNotMatch(protocolText, /dsh_github_status|dsh_github_create|dsh_git_push|dsh_handoff/);
  assert.match(protocolText, /fenced text code block/);
  assert.match(protocolText, /\$\{\{ \.\.\. \}\}/);
});

test('the saved permission selector overrides policy fields supplied in model tool arguments', async () => {
  const h = backgroundHarness();
  h.local.permissionMode = 'important';
  await h.chrome.runtime.sendMessage({ type: 'bridge', method: 'POST', path: '/tool', body: { tool: 'dsh_bash', args: { command: 'echo hi', permissionMode: 'full' }, permissionMode: 'full' } });
  assert.equal(h.requests[0].body.permissionMode, 'important');
  h.local.permissionMode = 'full';
  await h.chrome.runtime.sendMessage({ type: 'bridge', method: 'POST', path: '/tool', body: { tool: 'dsh_bash', args: { command: 'echo hi' } } });
  assert.equal(h.requests[1].body.permissionMode, 'full');
});

test('Reset restores the saved iteration budget while preserving prior tool outcomes for Resume', async () => {
  const h = contentHarness(['Finished without repeating tools.']);
  const entries = [{ role: 'user', content: 'Continue the task' }, { role: 'tool', tool_call_id: 'previous', tool: 'dsh_write', result: { ok: true } }];
  h.local['dshpro:conversation:' + url] = { conversationHistory: entries, iterationCount: 15, revision: 0, inProgress: true };
  await h.doReset();
  assert.equal(h.saved().iterationCount, 0);
  assert.deepEqual(h.saved().conversationHistory, entries);
  assert.equal(h.saved().inProgress, true);
  await h.startRun({ resume: true });
  assert.equal(h.saved().stage, 'completed');
  assert.equal(h.requests.length, 0);
});

test('ds_tool wrappers execute validated calls and never count as completion prose', async () => {
  const h = contentHarness(['<ds_tool>\n{"tool":"dsh_read","args":{"path":"maktab-sharif-landing/index.html"}}\n</ds_tool>', 'Read completed.']);
  await h.startRun({ task: 'Inspect the icons' });
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].body.args.path, 'maktab-sharif-landing/index.html');
  assert.equal(h.saved().iterationCount, 2);
  assert.equal(h.saved().stage, 'completed');
});

test('mixed wrappers share validation and preserve marker literals inside JSON and raw code', () => {
  const content = '<ds_tool>literal</ds_tool>\n' + protocol.OPEN + ' also literal ' + protocol.CLOSE;
  const xml = '<DS_TOOL>' + JSON.stringify({ tool: 'dsh_write', args: { path: 'a.txt', content } }) + '</ds_tool>';
  const mixed = protocol.parse(xml + '\n' + call('dsh_read', { path: 'b.txt' }) + '\n<ds-tool>{"tool":"dsh_log","args":{}}</ds-tool>');
  assert.equal(mixed.errors.length, 0);
  assert.equal(mixed.calls.length, 3);
  assert.equal(mixed.calls[0].args.content, content);
  assert.equal(protocol.parse(mixed.text + '\n' + call('dsh_read')).errors.length, 1);
  const raw = '<ds_tool>\n{"tool":"dsh_write","args":{"path":"a.txt"}}\n⟦DSH:ARG:content⟧\n' + content + '\n⟦/DSH:ARG:content⟧\n</ds_tool>';
  assert.equal(protocol.parse(raw).calls[0].args.content, content);
});

test('partial, orphaned, wrapper-free, and mixed invalid tool output never silently completes', async () => {
  for (const raw of ['<ds_tool>{"tool":"dsh_read","args":{}}', '</ds_tool>', '<ds_tool', '⟦DS', '```text\n⟦DS\n```', '⟦DSH', '⟦DSH⟧{"tool":"dsh_write', 'text', 'Safe', '', '```text\n```', '{"tool":"dsh_read","args":{}}', call('dsh_read', { path: 'a.txt' }) + '\n<ds_tool>{broken}</ds_tool>']) {
    assert.ok(protocol.parse(raw).errors.length, raw);
  }
  const h = contentHarness([call('dsh_read', { path: 'do-not-run.txt' }) + '\n<ds_tool>{broken}</ds_tool>', 'No changes needed.']);
  await h.startRun({ task: 'Inspect files' });
  assert.equal(h.requests.length, 0);
  assert.equal(h.saved().stage, 'completed');
});

test('incident cut points recover without executing fragments or replaying a preceding successful call', async () => {
  for (const fragment of ['⟦DS', '⟦DSH⟧{"tool":"dsh_write', 'text', 'Safe', '']) {
    const h = contentHarness([call('dsh_read', { path: 'already-read.txt' }), fragment, call('dsh_write', { path: 'small.txt', content: 'Small chunk' }), 'Finished.']);
    await h.startRun({ task: 'Read then write' });
    assert.equal(h.saved().stage, 'completed', fragment);
    assert.deepEqual(h.requests.map((request) => request.body.tool), ['dsh_read', 'dsh_write']);
    assert.match(h.sent[2], /No calls from that rejected response executed/);
    assert.equal(h.saved().conversationHistory.find((entry) => entry.kind === 'parse-error').retryCount, 1);
  }
  const h = contentHarness(['text', 'Safe', 'text']);
  await h.startRun({ task: 'Write a report' });
  assert.equal(h.saved().stage, 'error');
  assert.equal(h.saved().inProgress, true);
  assert.equal(h.requests.length, 0);
});

test('complete multi-KB writes preserve their content in both JSON and raw argument framing', () => {
  const content = '# Incident report\nUnicode: فارسی; "quotes", \\paths\n'.repeat(180);
  for (const raw of [call('dsh_write', { path: 'report.md', content }), `${protocol.OPEN}\n{"tool":"dsh_write","args":{"path":"report.md"}}\n⟦DSH:ARG:content⟧\n${content}\n⟦/DSH:ARG:content⟧\n${protocol.CLOSE}`]) {
    const parsed = protocol.parse(raw);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.calls[0].args.content, content);
  }
  const parsed = protocol.parse(Array(3).fill(call('dsh_read')).join('\n'));
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.calls.length, 3);
});

test('missing handoff credentials propagate to the model and remove handoff from the live catalog', async () => {
  const h = contentHarness([call('dsh_handoff', { planText: 'Read the research docs' }), call('dsh_read', { path: 'README.md' }), 'Read complete.']);
  h.setBridge(async () => ({ status: 200, json: { ok: true, data: { runId: 'missing-key', timeoutMs: 30000 } } }));
  const send = h.chrome.runtime.sendMessage;
  h.chrome.runtime.sendMessage = (msg) => msg.type === 'handoffStatus' ? Promise.resolve({ ok: true, json: { run: {
    status: 'failed', exitCode: 1, error: { code: 'E_MISSING_CREDENTIAL', message: 'Configure provider credentials; use direct tools.' },
  } } }) : send(msg);
  await h.startRun({ task: 'Research' });
  assert.equal(h.saved().stage, 'completed');
  assert.equal(h.state.health.dsh.available, false);
  assert.doesNotMatch(h.buildProtocolMessage(), /- dsh_handoff:/);
  const result = h.saved().conversationHistory.find((entry) => entry.role === 'tool').result;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'E_MISSING_CREDENTIAL');
  assert.match(h.sent[1], /Configure provider credentials/);
});

test('recovery excerpts are bounded while the exact truncated response remains saved', async () => {
  const bad = '⟦DSH⟧{"tool":"dsh_write","args":{"content":"' + 'x'.repeat(12000);
  const h = contentHarness([bad, 'No changes made.']);
  await h.startRun({ task: 'Write report' });
  const recovery = h.saved().conversationHistory.find((entry) => entry.kind === 'parse-error').content;
  assert.ok(recovery.length < 4000);
  assert.match(recovery, /Middle omitted/);
  assert.equal(h.saved().conversationHistory.find((entry) => entry.role === 'assistant').raw, bad);
  assert.equal(h.requests.length, 0);
});

test('an incomplete capture after rendering grace requests a complete block and records its provenance', async () => {
  const completion = { incompleteAfterGrace: true, capturedAt: '2026-10-24T10:00:00Z', messageKey: 'assistant-2', chars: 17, source: 'div.message', domStableMs: 2000 };
  const h = contentHarness(['⟦DSH⟧{"tool":"d', call('dsh_tree', { path: 'dragon-market', depth: 2 }), 'Located.'], { completion });
  await h.startRun({ task: 'Locate the local repository' });
  assert.equal(h.saved().stage, 'completed');
  assert.equal(h.requests.length, 1);
  assert.match(h.sent[1], /DeepSeek stopped rendering this reply before the tool block was complete/);
  assert.match(h.sent[1], /continue with one complete tool block/);
  assert.match(h.sent[1], /split it into hash-checked chunks and verify each chunk/);
  assert.match(h.nodes.get('dshpro-parser-error').textContent, /assistant-2; 17 characters from div.message/);
  assert.deepEqual(h.saved().conversationHistory.find((entry) => entry.role === 'assistant').completion, completion);
});

test('Resume starts a fresh parse-recovery budget without replaying prior completed tools', async () => {
  const h = contentHarness(['⟦DSH⟧{"tool":"d', call('dsh_read', { path: 'a.txt' }), 'Done.']);
  h.local['dshpro:conversation:' + url] = {
    conversationHistory: [{ role: 'user', content: 'Inspect the icons' }, { role: 'tool', tool: 'dsh_read', tool_call_id: 'old', result: { ok: true } }],
    iterationCount: 3, retryCount: 3, revision: 0, inProgress: true,
  };
  await h.startRun({ resume: true });
  assert.equal(h.saved().stage, 'completed');
  assert.equal(h.requests.length, 1);
  assert.match(h.sent[1], /exactly ONE complete tool call/);
  assert.match(h.sent[1], /No calls from that rejected response executed/);
});
