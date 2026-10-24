'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { history } = require('../src/core/history.js');

test('a long transcript keeps the latest task and unresolved effects within the outbound budget', () => {
  const entries = [{ role: 'user', content: 'Keep this current task: repair YAML and push to the chosen repository.' },
    { role: 'system', kind: 'tool-intent', tool: 'dsh_git_push', tool_call_id: 'uncertain-push', args: { path: 'project', remote: 'origin' } }];
  for (let i = 0; i < 180; i++) entries.push({ role: 'assistant', content: 'Old verbose response. '.repeat(600) });
  const before = JSON.stringify(entries);
  const view = history.build(entries);
  assert.ok(JSON.stringify(view).length < 150000);
  assert.ok(view.omittedEntries > 0);
  assert.match(JSON.stringify(view), /repair YAML and push/);
  assert.match(JSON.stringify(view), /uncertain-push/);
  assert.match(view.note, /unresolved intents/);
  assert.equal(JSON.stringify(entries), before);
});

test('tool result projection preserves failures and their recovery details without duplicate serialized results', () => {
  const result = { ok: false, error: { code: 'E_HANDOFF_FAILED', message: 'Launcher failed' }, data: { stdout: 'verbose'.repeat(12000), stderrFile: '.dsh-pro/outputs/stderr.txt' } };
  const view = history.build([{ role: 'tool', tool: 'dsh_handoff', tool_call_id: 'failed', content: JSON.stringify(result), result }]);
  assert.equal(view.conversationHistory[0].result.error.code, 'E_HANDOFF_FAILED');
  assert.equal(view.conversationHistory[0].result.data.stderrFile, '.dsh-pro/outputs/stderr.txt');
  assert.equal(view.conversationHistory[0].content, undefined);
  assert.ok(JSON.stringify(view).length < 10000);
});

test('compact history retains user-facing summaries, commentary, and workspace identity', () => {
  const entries = [
    { role: 'assistant', narration: 'The current setting is incorrect.', tool_calls: [{ tool: 'dsh_edit', summary: 'I am correcting the setting.', args: { path: 'settings.json', oldText: 'old', newText: 'new' } }] },
    { role: 'system', kind: 'tool-intent', tool: 'dsh_edit', summary: 'I am correcting the setting.', workspace: 'C:/project', args: { path: 'settings.json' } },
  ];
  const before = JSON.stringify(entries);
  const view = history.build(entries).conversationHistory;
  assert.equal(view[0].content, 'The current setting is incorrect.');
  assert.equal(view[0].tool_calls[0].summary, 'I am correcting the setting.');
  assert.equal(view[1].workspace, 'C:/project');
  assert.equal(view[1].summary, 'I am correcting the setting.');
  assert.equal(JSON.stringify(entries), before);
});

test('rejected turns do not project partially parsed calls as executable history', () => {
  const entries = [{ role: 'assistant', content: 'Original rejected response', raw: 'Original rejected response',
    tool_calls: [{ tool: 'dsh_read', args: { path: 'must-not-run.txt' } }],
    parseErrors: [{ code: 'E_TOO_MANY_CALLS', message: 'Too many calls; the maximum is 3 per response.', raw: 'Rejected trailing calls' }],
  }];
  const before = JSON.stringify(entries);
  const [row] = history.build(entries).conversationHistory;
  assert.equal(row.kind, 'rejected-response');
  assert.match(row.content, /No calls from this response executed/);
  assert.equal(row.parseErrors[0].code, 'E_TOO_MANY_CALLS');
  assert.equal(row.tool_calls, undefined);
  assert.equal(row.parseErrors[0].raw, undefined);
  assert.equal(JSON.stringify(entries), before);
});

test('instruction-deferred proposals stay unexecuted in compact history', () => {
  const entry = { role: 'assistant', raw: 'Original proposal', deferred: true, tool_calls: [{ tool: 'dsh_write', args: { path: 'src/a.js' } }] };
  const [row] = history.build([entry]).conversationHistory;
  assert.equal(row.kind, 'deferred-response');
  assert.equal(row.tool_calls, undefined);
  assert.match(row.content, /did not execute/);
  assert.equal(entry.raw, 'Original proposal');
});
