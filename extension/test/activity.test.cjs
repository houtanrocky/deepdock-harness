const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { protocol } = require('../src/core/protocol.js');
const { activityView, activityText } = require('../src/core/activity.js');
const { runTool } = require('../../bridge/tools');

test('tool summaries and surrounding commentary are preserved without exposing raw protocol as explanations', () => {
  const raw = 'I found the setting to change.\n```text\n⟦DSH⟧' + JSON.stringify({ tool: 'dsh_edit', summary: 'I am updating the greeting.', args: { path: 'app.js', oldText: 'old', newText: 'new' } }) + '⟦/DSH⟧\n```';
  const parsed = protocol.parse(raw);
  assert.equal(parsed.calls[0].summary, 'I am updating the greeting.');
  assert.equal(parsed.narration, 'I found the setting to change.');
  const model = activityView([{ role: 'system', kind: 'protocol', content: 'internal' }, { role: 'user', content: 'Fix the greeting' }, { role: 'assistant', content: raw }, { role: 'assistant', content: 'DSH:DONE:Changed the greeting and checked it.' }]);
  assert.deepEqual(model.rows.map((row) => row.kind), ['user', 'assistant', 'assistant']);
  assert.equal(model.rows[1].text, 'I found the setting to change.');
  assert.equal(model.rows[2].text, 'Changed the greeting and checked it.');
  assert.doesNotMatch(JSON.stringify(model), /oldText/);
});

test('activity joins intents and results and only reports confirmed changes per workspace', () => {
  const intent = (id, workspace) => ({ id, role: 'system', kind: 'tool-intent', tool_call_id: id, tool: 'dsh_write', workspace, args: { path: 'a.txt', content: 'new' }, summary: 'Update the file.' });
  const result = (id, ok) => ({ role: 'tool', tool_call_id: id, result: { ok, data: ok ? { file: 'a.txt', change: { file: 'a.txt', kind: 'updated', diff: '-old\n+new' } } : undefined, error: ok ? undefined : { code: 'E_STALE_FILE', message: 'Changed externally' } } });
  const model = activityView([intent('a', 'C:/one'), result('a', true), intent('b', 'C:/one'), result('b', false), intent('c', 'C:/two'), result('c', true)]);
  assert.equal(model.rows.length, 3);
  assert.deepEqual(model.rows.map((row) => row.status), ['succeeded', 'failed', 'succeeded']);
  assert.equal(model.rows[0].summary, 'Update the file.');
  assert.equal(model.changes.length, 2);
  assert.equal(model.changes[0].count, 1);
  assert.equal(model.rows[1].result.error.code, 'E_STALE_FILE');
});

test('pending steps distinguish approval, running, denial, and unknown outcomes after interruption', () => {
  const entry = { id: 'a', runId: 'active', role: 'system', kind: 'tool-intent', tool: 'dsh_bash', args: { command: 'echo hello' }, tool_call_id: 'step' };
  assert.equal(activityView([entry], { activeRunId: 'active' }).rows[0].status, 'running');
  assert.equal(activityView([entry], { activeRunId: 'active', approval: true }).rows[0].status, 'approval');
  assert.equal(activityView([entry]).rows[0].status, 'uncertain');
  assert.equal(activityView([entry], { activeRunId: 'different' }).rows[0].status, 'uncertain');
  for (const [code, status] of [['E_USER_DENIED', 'denied'], ['E_BRIDGE_UNREACHABLE', 'uncertain']]) {
    const model = activityView([entry, { role: 'tool', tool_call_id: 'step', result: { ok: false, error: { code } } }]);
    assert.equal(model.rows[0].status, status);
    assert.equal(model.changes.length, 0);
  }
  assert.equal(activityView([entry, { role: 'tool', tool_call_id: 'step', result: { ok: false, error: { code: 'E_TIMEOUT', extra: { terminationConfirmed: false } } } }]).rows[0].status, 'uncertain');
});

test('activity rendering redacts known credentials while preserving saved history and hashes', () => {
  const original = { confirmToken: 'private-confirmation', content: 'Bearer token-value; sk-exampleSecret123; local-private-token', sha256: 'a'.repeat(64) };
  const displayed = activityText(original, ['local-private-token']);
  assert.doesNotMatch(displayed, /private-confirmation|token-value|sk-exampleSecret123|local-private-token/);
  assert.match(displayed, new RegExp('a'.repeat(64)));
  assert.equal(original.confirmToken, 'private-confirmation');
});

test('legacy native tool markup appears as unexecuted markup rather than an assistant completion', () => {
  const view = activityView([{ role: 'assistant', content: '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="bash">dir</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>', narration: '', tool_calls: [], parseErrors: [] }]);
  assert.equal(view.rows[0].kind, 'recovery');
  assert.equal(view.rows[0].title, 'Unexecuted native tool markup');
  assert.equal(view.changes.length, 0);
});

test('file results carry bounded before/after diffs for writes, appends, and exact edits', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-activity-'));
  t.after(() => {
    assert.equal(path.dirname(workspace), os.tmpdir());
    assert.ok(path.basename(workspace).startsWith('dsh-activity-'));
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  const ctx = { workspace, config: { allowedRoots: [workspace] }, confirmed: true };
  const created = await runTool('dsh_write', { path: 'a.txt', content: 'first\nold\nlast\n' }, ctx);
  assert.equal(created.change.kind, 'created');
  assert.match(created.change.diff, /--- \/dev\/null/);
  const edited = await runTool('dsh_edit', { path: 'a.txt', oldText: 'old', newText: 'new' }, ctx);
  assert.match(edited.change.diff, /-old\n\+new/);
  assert.match(edited.change.diff, / first/);
  const appended = await runTool('dsh_write', { path: 'a.txt', append: true, content: 'added\n', expectedSha256: edited.sha256 }, ctx);
  assert.equal(appended.change.kind, 'appended');
  assert.match(appended.change.diff, /\+added/);
  const unchanged = await runTool('dsh_write', { path: 'a.txt', content: 'first\nnew\nlast\nadded\n' }, ctx);
  assert.equal(unchanged.change.kind, 'unchanged');
  const huge = await runTool('dsh_write', { path: 'big.txt', content: 'line\n'.repeat(10000) }, ctx);
  assert.equal(huge.change.truncated, true);
  assert.ok(huge.change.diff.length < 8500);
  const env = await runTool('dsh_write', { path: '.env', content: 'SECRET=old-private-value' }, ctx);
  assert.equal(env.change.diff, '');
  const envUpdated = await runTool('dsh_write', { path: '.env', content: 'SECRET=new-private-value' }, ctx);
  assert.doesNotMatch(JSON.stringify(envUpdated.change), /old-private|new-private/);
  assert.match(envUpdated.change.note, /policy/);
});
