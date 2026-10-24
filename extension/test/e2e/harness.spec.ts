import { test, expect, enable, queue, submit, complete, checkpoint, tool, TOKEN } from './fixtures';
import { readFile } from 'node:fs/promises';
const nativeDsml = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="bash">\n<｜｜DSML｜｜ parameter name="command" string="true">powershell -Command "Get-ChildItem | Where-Object { _.FullName -notmatch nodemodules }"</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';

test('shell failures followed by native DSML recover without silently completing or executing damaged commands', async ({ chat, bridge, worker }) => {
  bridge.toolErrors.set('broad PDF search', { code: 'E_TIMEOUT', message: 'Search timed out', extra: { stdout: 'main.go\n---WS-PDF---', timeoutMs: 20000, terminationConfirmed: true } });
  bridge.toolErrors.set('narrow PDF search', { code: 'E_COMMAND_FAILED', message: 'Exit code 1; no stdout or stderr', extra: { stdout: '', stderr: '', exitCode: 1 } });
  await enable(chat);
  await queue(chat, [
    tool('dsh_bash', { command: 'broad PDF search' }),
    tool('dsh_bash', { command: 'narrow PDF search' }),
    { html: `<pre><code>${nativeDsml}</code></pre>` },
    { html: '<DSML><invoke name="bash">damaged-command-must-not-run</invoke></DSML>' },
    tool('dsh_read', { path: 'review/README.md' }),
    'Read the review through the file tool.',
  ]);
  await submit(chat, 'Read the review report');
  await complete(chat, worker, 30_000);
  expect(bridge.calls.map((call) => call.tool)).toEqual(['dsh_bash', 'dsh_bash', 'dsh_read']);
  expect(bridge.calls.map((call) => call.args.command).filter(Boolean)).toEqual(['broad PDF search', 'narrow PDF search']);
  const saved = await checkpoint(chat, worker);
  expect(saved.conversationHistory.filter((entry: any) => entry.kind === 'parse-error')).toHaveLength(2);
  expect(saved.conversationHistory.filter((entry: any) => entry.role === 'assistant' && entry.parseErrors?.[0]?.code === 'E_UNSUPPORTED_TOOL_FORMAT').every((entry: any) => entry.completion.incompleteAfterGrace === false)).toBe(true);
  await expect(chat.locator('#dshpro-timeline')).toContainText('Search timed out');
  await expect(chat.locator('#dshpro-timeline')).toContainText('Response rejected');
  const sent = await chat.evaluate(() => (window as any).fixture.sent);
  expect(sent.some((message: string) => message.includes('unsupported native DSML'))).toBe(true);
});

test('saved report path failures recover using the provided workspace and read call', async ({ chat, bridge, worker }) => {
  const readWith = { tool: 'dsh_read', args: { workspace: 'C:/fixture', path: '.dsh-pro/outputs/review.stdout.txt', offset: 1, limit: 80 } };
  bridge.toolData.set('dsh_bash', { fullOutputFile: '.dsh-pro/outputs/review.json', fullOutputWorkspace: 'C:/fixture', textOutputFile: readWith.args.path, readWith });
  bridge.toolErrors.set('../.dsh-pro/outputs/review.json', { code: 'E_PATH_ESCAPE', message: 'Path escapes the workspace root' });
  await enable(chat);
  await queue(chat, [
    tool('dsh_bash', { command: 'git show HEAD:REVIEW_REPORT.md' }),
    tool('dsh_read', { path: '../.dsh-pro/outputs/review.json' }),
    nativeDsml,
    tool(readWith.tool, readWith.args),
    'The saved review report was read.',
  ]);
  await submit(chat, 'Read the full report');
  await complete(chat, worker, 25_000);
  expect(bridge.calls.map((call) => call.tool)).toEqual(['dsh_bash', 'dsh_read', 'dsh_read']);
  expect(bridge.calls[2].args).toEqual(readWith.args);
  expect(bridge.calls[2].args.path).not.toContain('../');
  expect((await checkpoint(chat, worker)).conversationHistory.some((entry: any) => entry.kind === 'tool-recovery' && entry.content.includes(JSON.stringify(readWith)))).toBe(true);
});

test('a legacy task falsely completed on DSML offers Resume without replaying the native command', async ({ chat, bridge, worker }) => {
  const key = 'dshpro:conversation:' + chat.url();
  await worker.evaluate(({ key, nativeDsml }) => chrome.storage.local.set({ [key]: {
    revision: 0, iterationCount: 3, stage: 'completed', inProgress: false,
    conversationHistory: [{ role: 'user', content: 'Read the review report.' }, { role: 'assistant', content: nativeDsml, raw: nativeDsml, narration: '', parseErrors: [], tool_calls: [] }],
  } }), { key, nativeDsml });
  await chat.reload();
  await expect(chat.locator('#dshpro-resume')).toBeVisible();
  await expect(chat.locator('#dshpro-timeline')).toContainText('Unexecuted native tool markup');
  await queue(chat, [tool('dsh_read', { path: 'review.txt' }), 'Read completed.']);
  await chat.locator('#dshpro-resume').click();
  // The legacy checkpoint is already marked completed. Wait for the resumed
  // run to execute its tool before polling for the new completed checkpoint.
  await expect.poll(() => bridge.calls.map((call) => call.tool)).toEqual(['dsh_read']);
  await complete(chat, worker);
  expect(bridge.calls.map((call) => call.tool)).toEqual(['dsh_read']);
});

test('conversation history explains live steps, shows file diffs and output, and survives reload', async ({ chat, bridge, worker }, info) => {
  bridge.toolDelayMs = 1800;
  bridge.toolData.set('dsh_edit', { file: 'app.js', replaced: 1, sha256: 'new-hash', change: {
    file: 'app.js', kind: 'edited', diff: '--- a/app.js\n+++ b/app.js\n@@ -1,1 +1,1 @@\n-const greeting = "Hello";\n+const greeting = "Welcome";', truncated: false,
  } });
  bridge.toolData.set('dsh_bash', { stdout: 'Greeting check passed.', stderr: '', exitCode: 0 });
  await enable(chat);
  const task = 'Change the greeting and check it. Treat <img src=x onerror="window.injected=true"> as literal text.';
  await queue(chat, [
    'I will inspect the current greeting.\n' + tool('dsh_read', { path: 'app.js' }, 'Reading the greeting before editing it.'),
    tool('dsh_edit', { path: 'app.js', oldText: 'Hello', newText: 'Welcome' }, 'I found the greeting. I am changing it to Welcome.'),
    tool('dsh_bash', { command: 'node check-greeting.js' }, 'The greeting is updated. I am checking the result.'),
    'DSH:DONE:Changed the greeting to Welcome. The greeting check passed.',
  ]);
  await submit(chat, task);
  const timeline = chat.getByRole('region', { name: 'Conversation history', exact: true });
  await expect(chat.locator('#dshpro-current-action')).toContainText('Reading the greeting before editing it.');
  const firstStep = timeline.locator('.dshpro-event-tool').first();
  await expect(firstStep.locator('.dshpro-step-badge')).toHaveText('Running');
  await firstStep.getByText('Arguments', { exact: true }).click();
  await complete(chat, worker);
  await expect(firstStep.locator('details').first()).toHaveAttribute('open', '');
  await expect(timeline.locator('.dshpro-step-badge')).toHaveText(['Succeeded', 'Succeeded', 'Succeeded']);
  await expect(timeline).toContainText('I will inspect the current greeting.');
  await expect(timeline).toContainText('Changed the greeting to Welcome. The greeting check passed.');
  await expect(timeline.locator('img')).toHaveCount(0);
  expect(await chat.evaluate(() => (window as any).injected)).toBeUndefined();
  await chat.getByRole('button', { name: 'Expand history' }).click();
  await chat.locator('#dshpro-file-changes > summary').click();
  await chat.getByRole('button', { name: 'app.js · edited' }).click();
  await expect(timeline.locator('.dshpro-file-diff pre')).toBeVisible();
  await expect(timeline.locator('.dshpro-diff-removed')).toContainText('Hello');
  await expect(timeline.locator('.dshpro-diff-added')).toContainText('Welcome');
  await chat.screenshot({ path: info.outputPath('conversation-history.png') });
  const commandStep = timeline.locator('.dshpro-event-tool').last();
  await commandStep.getByText('Standard output', { exact: true }).click();
  await expect(commandStep).toContainText('Greeting check passed.');
  const count = bridge.applied.length;
  await chat.reload();
  await expect(timeline).toContainText('Changed the greeting to Welcome.');
  await expect(timeline.locator('.dshpro-event-tool')).toHaveCount(3);
  expect(bridge.applied).toHaveLength(count);
  await chat.setViewportSize({ width: 360, height: 740 });
  await chat.getByRole('button', { name: 'Expand history' }).click();
  const box = await chat.locator('#dshpro-panel').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  await chat.screenshot({ path: info.outputPath('conversation-history-mobile.png') });
});

test('history labels interrupted outcomes and pending approvals without claiming file changes', async ({ chat, bridge, worker }) => {
  const key = 'dshpro:conversation:' + chat.url();
  await worker.evaluate((key) => chrome.storage.local.set({ [key]: { revision: 0, inProgress: false, iterationCount: 0, conversationHistory: [
    { id: 'old-task', role: 'user', content: 'An earlier interrupted task' },
    { id: 'old-intent', runId: 'interrupted', role: 'system', kind: 'tool-intent', tool_call_id: 'unknown-write', tool: 'dsh_write', args: { path: 'unknown.txt', content: 'Uncertain' } },
  ] } }), key);
  await chat.reload();
  const timeline = chat.getByRole('region', { name: 'Conversation history', exact: true });
  await expect(timeline).toContainText('Outcome unknown');
  await enable(chat);
  await chat.getByLabel('Permissions', { exact: true }).selectOption('always');
  await queue(chat, [tool('dsh_write', { path: 'denied.txt', content: 'Denied' }, 'I am ready to write the file.'), 'No file was written because the request was denied.']);
  await submit(chat, 'Write a file');
  await expect(chat.getByRole('alertdialog')).toBeVisible();
  await expect(chat.locator('#dshpro-current-action')).toContainText('Awaiting approval');
  await expect(timeline).toContainText('Awaiting approval');
  expect(bridge.calls).toHaveLength(0);
  await chat.getByRole('button', { name: 'Deny', exact: true }).click();
  await complete(chat, worker);
  await expect(timeline.locator('.dshpro-step-badge')).toHaveText(['Outcome unknown', 'Denied']);
  await expect(chat.locator('#dshpro-file-changes')).toBeHidden();
  expect(bridge.applied).toHaveLength(0);
});

test('history loads older entries, preserves scrollback during new activity, and masks displayed credentials', async ({ chat, bridge, worker }) => {
  const key = 'dshpro:conversation:' + chat.url();
  await worker.evaluate(({ key, token }) => chrome.storage.local.set({ [key]: { revision: 0, iterationCount: 0, inProgress: false, conversationHistory: Array.from({ length: 130 }, (_, index) => ({
    id: `history-${index}`, role: index % 2 ? 'assistant' : 'user', content: `Archived update ${index}: ` + (index === 70 ? token : 'Read the earlier research notes.').repeat(4),
  })) } }), { key, token: TOKEN });
  await chat.reload();
  const timeline = chat.getByRole('region', { name: 'Conversation history', exact: true });
  await expect(timeline.locator('.dshpro-event')).toHaveCount(60);
  await expect(timeline).not.toContainText(TOKEN);
  await expect(timeline).toContainText('[redacted]');
  await timeline.getByRole('button', { name: 'Show earlier activity (70)' }).click();
  await expect(timeline.locator('.dshpro-event')).toHaveCount(120);
  await enable(chat);
  await timeline.evaluate((element) => { element.scrollTop = 50; });
  const first = await timeline.locator('.dshpro-event').first().getAttribute('data-event-id');
  await queue(chat, ['The new task is complete.']);
  await submit(chat, 'Continue with another task');
  await complete(chat, worker);
  expect(await timeline.locator('.dshpro-event').first().getAttribute('data-event-id')).toBe(first);
  expect(await timeline.evaluate((element) => element.scrollTop)).toBe(50);
  await timeline.getByRole('button', { name: /Show earlier activity/ }).click();
  await expect(timeline).toContainText('Archived update 0:');
  expect(bridge.calls).toHaveLength(0);
  expect((await checkpoint(chat, worker)).conversationHistory[70].content).toContain(TOKEN);
});

test('first-use pairing through Settings connects and starts a working agent', async ({ chat, bridge, worker }) => {
  await worker.evaluate(() => chrome.storage.local.clear());
  await chat.reload();
  await expect(chat.locator('#dshpro-connection')).toHaveText('OFFLINE');
  await chat.getByRole('button', { name: 'Settings', exact: true }).click();
  await chat.getByLabel('Bridge address').fill(bridge.baseUrl);
  await chat.getByLabel('Bridge token', { exact: true }).fill(TOKEN);
  await chat.getByRole('button', { name: 'Save settings' }).click();
  await expect(chat.locator('#dshpro-settings-feedback')).toContainText('Settings saved.');
  await expect(chat.getByLabel('Bridge token', { exact: true })).toHaveValue('');
  await chat.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(chat.locator('#dshpro-settings')).toBeHidden();
  await expect(chat.locator('#dshpro-connection')).toHaveText('CONNECTED');
  await enable(chat);
  await queue(chat, [tool('dsh_read', { path: 'first-task.txt' }), 'Done.']);
  await submit(chat, 'Read first-task.txt');
  await complete(chat, worker);
  expect(bridge.applied[0].args.path).toBe('first-task.txt');
});

test('packaged extension drives the semantic chat, repairs JSON, and records sequential tools', async ({ chat, bridge, worker }) => {
  await chat.goto('https://chat.deepseek.com/a/chat/s/semantic-loop');
  await enable(chat);
  const code = '<a href="link">Hello</a>\n<script>console.log("ok");</script>';
  const malformed = '⟦DSH⟧{"tool":"dsh_write","args":{"path":"index.html","content":"' + code + '"}}⟦/DSH⟧';
  await queue(chat, [malformed, tool('dsh_read', { path: 'index.html' }), 'Finished.']);
  await submit(chat, 'Build a page and read it back');
  await complete(chat, worker);
  expect(bridge.applied.map((call) => call.tool)).toEqual(['dsh_write', 'dsh_read']);
  expect(bridge.applied[0].args.content).toBe(code);
  const saved = await checkpoint(chat, worker);
  expect(saved.conversationHistory.filter((entry: any) => entry.role === 'tool')).toHaveLength(2);
  const sent = await chat.evaluate(() => (window as any).fixture.sent as string[]);
  expect(sent.some((message) => message.includes('previous tool JSON required automatic repair'))).toBe(true);
  expect(JSON.stringify(sent)).not.toContain(TOKEN);
});

test('five valid calls reject atomically and recover with a dedicated limit message', async ({ chat, bridge, worker }) => {
  await enable(chat);
  const paths = ['Notification.java', 'NotificationEmailService.java', 'NotificationSmsService.java', 'DiscountPercentageStrategy.java', 'DiscountNoDiscountStrategy.java'];
  const rejected = paths.map((path) => tool('dsh_read', { path })).join('\n');
  await queue(chat, [rejected, tool('dsh_read', { path: paths[0] }), 'Read the notification interface.']);
  await submit(chat, 'Read the notification interface');
  await complete(chat, worker);
  expect(bridge.calls.map((call) => call.args.path)).toEqual([paths[0]]);
  const saved = await checkpoint(chat, worker);
  const failed = saved.conversationHistory.find((entry: any) => entry.parseErrors?.length);
  expect(failed.raw).toBe(rejected);
  expect(failed.parseErrors[0].code).toBe('E_TOO_MANY_CALLS');
  const sent = await chat.evaluate(() => (window as any).fixture.sent as string[]);
  const recovery = sent.find((message) => message.includes('exceeded the tool-call limit'));
  expect(recovery).toContain('No calls from that rejected response executed, including the first 3');
  expect(recovery).toContain('"kind":"rejected-response"');
  expect(recovery).not.toContain('Your JSON was malformed');
});

test('observed DeepSeek layout preserves raw HTML, YAML, and XML tool wrappers', async ({ chat, bridge, worker }) => {
  await enable(chat);
  const yaml = 'name: Deploy\non:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    environment:\n      url: ${{ steps.deployment.outputs.page_url }}\n    steps:\n      - run: |\n          echo ready\n          echo done\n';
  const raw = `⟦DSH⟧\n{"tool":"dsh_write","args":{"path":"workflow.yml"}}\n⟦DSH:ARG:content⟧\n${yaml}\n⟦/DSH:ARG:content⟧\n⟦/DSH⟧`;
  const escaped = raw.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const html = '<p>⟦DSH⟧{"tool":"dsh_write","args":{"path":"index.html"}}<br>⟦DSH:ARG:content⟧</p><span class="ds-markdown-html">&lt;!DOCTYPE html&gt;</span><span class="ds-markdown-html">&lt;html&gt;Local agent&lt;/html&gt;\n⟦/DSH:ARG:content⟧\n⟦/DSH⟧</span>';
  await queue(chat, [
    { html, partial: tool('dsh_read', { path: 'must-not-execute' }), delay: 1000 },
    { html: `<div class="ds-code-block"><pre><code>${escaped}</code></pre></div>` },
    { html: '<ds_tool><p>{"tool":"dsh_read","args":{"path":"workflow.yml"}}</p></ds_tool>' },
    'Finished.',
  ]);
  await submit(chat, 'Create the page and workflow');
  await chat.waitForFunction(() => (window as any).fixture.generating);
  expect(bridge.calls).toHaveLength(0);
  await complete(chat, worker);
  expect(bridge.applied.map((call) => call.args.path)).toEqual(['index.html', 'workflow.yml', 'workflow.yml']);
  expect(bridge.applied[0].args.content).toBe('<!DOCTYPE html>\n<html>Local agent</html>');
  expect(bridge.applied[1].args.content).toBe(yaml);
});

test('recycled completion controls and delayed code rendering never execute partial output', async ({ chat, bridge, worker }) => {
  await enable(chat);
  await queue(chat, [
    { reusePrevious: true, stopDelay: 500, delay: 1100, partial: tool('dsh_read', { path: 'partial.txt' }), text: tool('dsh_read', { path: 'final.txt' }) },
    { html: `<pre><code>${tool('dsh_read', { path: 'late.txt' })}</code></pre>`, partial: '⟦DSH⟧{"tool":"d', delay: 500, renderDelay: 150 },
    'Finished.',
  ]);
  await submit(chat);
  await chat.waitForFunction(() => (window as any).fixture.generating);
  await chat.waitForTimeout(350); // Explicitly inspect the valid-looking streaming partial.
  expect(bridge.calls).toHaveLength(0);
  await complete(chat, worker);
  expect(bridge.applied.map((call) => call.args.path)).toEqual(['final.txt', 'late.txt']);
  await expect(chat.locator('#dshpro-parser-error')).toBeHidden();
});

test('a complete dsh_tree rendered after its footer is captured intact without a premature parse retry', async ({ chat, bridge, worker }) => {
  await enable(chat);
  const args = { workspace: 'C:/fixture', path: 'dragon-market', depth: 2 };
  const full = tool('dsh_tree', args, 'Locating the dragon market repository in the workspace.');
  await queue(chat, [
    { html: `<pre><code>${full}</code></pre>`, partial: '⟦DSH⟧\n{"tool":"d', delay: 250, renderDelay: 1400 },
    'Repository located.',
  ]);
  await submit(chat, 'Find the dragon market repository');
  await chat.waitForFunction(() => (window as any).fixture.sent.length === 2 && !(window as any).fixture.generating);
  await chat.waitForTimeout(700); // Footer is visible; the final code block is still rendering.
  expect(bridge.calls).toHaveLength(0);
  await expect(chat.locator('#dshpro-parser-error')).toBeHidden();
  expect((await checkpoint(chat, worker)).conversationHistory.filter((entry: any) => entry.role === 'assistant' && entry.parseErrors?.length)).toHaveLength(0);
  await complete(chat, worker);
  expect(bridge.applied).toHaveLength(1);
  expect(bridge.applied[0].args).toEqual(args);
  const saved = await checkpoint(chat, worker);
  const captured = saved.conversationHistory.find((entry: any) => entry.tool_calls?.[0]?.tool === 'dsh_tree');
  expect(captured.raw).toBe(full);
  expect(saved.conversationHistory.some((entry: any) => entry.kind === 'parse-error')).toBe(false);
});

test('Continue collects successive segments before executing a complete tool call once', async ({ chat, bridge, worker }) => {
  await enable(chat);
  const full = tool('dsh_write', { path: 'continued.txt', content: 'The entire continued response.' });
  await queue(chat, [
    { text: full.slice(0, -10), continuation: {
      text: full, stopDelay: 500, delay: 900, continueLabel: '继续生成',
      continuation: { text: full + '\nReady to save.', stopDelay: 500, delay: 900 },
    } },
    'Saved the complete response.',
  ]);
  await submit(chat, 'Save a long response');
  await chat.waitForFunction(() => (window as any).fixture.continueClicks.length === 1);
  await chat.waitForTimeout(350); // The paused footer persists before Stop appears.
  expect(bridge.calls).toHaveLength(0);
  await chat.waitForFunction(() => (window as any).fixture.continueClicks.length === 2);
  await chat.waitForTimeout(350); // Even the valid middle segment must not execute.
  expect(bridge.calls).toHaveLength(0);
  await complete(chat, worker);
  expect(bridge.applied.map((call) => call.args)).toEqual([{ path: 'continued.txt', content: 'The entire continued response.' }]);
  const saved = await checkpoint(chat, worker);
  const captured = saved.conversationHistory.find((entry: any) => entry.tool_calls?.[0]?.tool === 'dsh_write');
  expect(captured.raw).toBe(full + '\nReady to save.');
  expect(captured.completion.continuationCount).toBe(2);
  expect(saved.conversationHistory.some((entry: any) => entry.kind === 'parse-error')).toBe(false);
  expect(await chat.evaluate(() => (window as any).fixture.sent.length)).toBe(3);
});

test('Continue waits for an enabled control and captures the full prose response', async ({ chat, bridge, worker }) => {
  await enable(chat);
  await queue(chat, [{ text: 'A partial answer.', continueLabel: 'Continue generating', continueEnableDelay: 900,
    continuation: { text: 'A partial answer. Here is the rest of the answer.' } }]);
  await submit(chat);
  await expect(chat.getByRole('button', { name: 'Continue generating', exact: true })).toBeDisabled();
  await chat.waitForTimeout(400);
  expect((await checkpoint(chat, worker)).stage).not.toBe('completed');
  expect(await chat.evaluate(() => (window as any).fixture.continueClicks)).toEqual([]);
  await complete(chat, worker);
  const saved = await checkpoint(chat, worker);
  expect(saved.conversationHistory.filter((entry: any) => entry.role === 'assistant').at(-1).raw).toBe('A partial answer. Here is the rest of the answer.');
  expect(bridge.calls).toHaveLength(0);
});

test('Continue ignores old messages and Markdown controls', async ({ chat, bridge, worker }) => {
  await enable(chat);
  await chat.evaluate(() => {
    const old = document.querySelector('#messages')!.lastElementChild!;
    old.insertAdjacentHTML('beforeend', '<button onclick="window.fixture.continueClicks.push(\'old\')">Continue</button>');
  });
  await queue(chat, [{ html: '<p>Completed answer.</p><button onclick="window.fixture.continueClicks.push(\'markdown\')">Continue</button>' }]);
  await submit(chat);
  await complete(chat, worker);
  expect(await chat.evaluate(() => (window as any).fixture.continueClicks)).toEqual([]);
  expect(bridge.calls).toHaveLength(0);
});

test('an unresponsive Continue is clicked once and Stop cancels the pending response', async ({ chat, bridge, worker }) => {
  await enable(chat);
  await queue(chat, [{ text: tool('dsh_read', { path: 'must-not-run.txt' }), ignoreContinue: true, continuation: { text: 'Unreachable' } }]);
  await submit(chat);
  await chat.waitForFunction(() => (window as any).fixture.continueClicks.length === 1);
  await chat.waitForTimeout(500);
  expect(bridge.calls).toHaveLength(0);
  expect((await checkpoint(chat, worker)).stage).not.toBe('completed');
  expect(await chat.evaluate(() => (window as any).fixture.continueClicks.length)).toBe(1);
  await chat.locator('#dshpro-stop').click();
  await expect(chat.locator('#dshpro-stop')).toBeDisabled();
  await chat.evaluate(() => document.querySelector('#messages')!.lastElementChild!.append(document.createElement('span')));
  await chat.waitForTimeout(300);
  expect(await chat.evaluate(() => (window as any).fixture.continueClicks.length)).toBe(1);
  expect(bridge.calls).toHaveLength(0);
});

test('a temporary Stop-button gap cannot complete a valid-looking partial tool call', async ({ chat, bridge, worker }) => {
  await enable(chat);
  await queue(chat, [
    { partial: tool('dsh_read', { path: 'partial-must-not-run.txt' }), text: tool('dsh_read', { path: 'final.txt' }), delay: 2000, stopGap: { after: 250, duration: 900 } },
    'Read completed.',
  ]);
  await submit(chat);
  await chat.waitForFunction(() => (window as any).fixture.generating);
  await chat.waitForTimeout(900);
  expect(bridge.calls).toHaveLength(0);
  await complete(chat, worker);
  expect(bridge.applied.map((call) => call.args.path)).toEqual(['final.txt']);
});

test('assistant extraction includes sibling code blocks and chooses the newest message across layouts', async ({ chat, bridge, worker }) => {
  await enable(chat);
  const remainder = '"dsh_tree","args":{"path":"dragon-market","depth":2}}⟦/DSH⟧';
  await queue(chat, [
    { html: '<div class="ds-assistant-message-main-content">⟦DSH⟧\n{"tool":</div><div class="ds-markdown"><pre><code>' + remainder + '</code></pre></div>' },
    { semantic: true, text: tool('dsh_read', { path: 'dragon-market/README.md' }) },
    'Repository inspected.',
  ]);
  await submit(chat);
  await complete(chat, worker);
  expect(bridge.applied.map((call) => call.tool)).toEqual(['dsh_tree', 'dsh_read']);
  await expect(chat.locator('#dshpro-parser-error')).toBeHidden();
});

test('permission settings persist and denial prevents requests while allow-once confirms exactly once', async ({ chat, bridge, worker }) => {
  await chat.getByLabel('Permissions', { exact: true }).selectOption('always');
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('permissionMode')).permissionMode)).toBe('always');
  await chat.reload();
  await expect(chat.getByLabel('Permissions', { exact: true })).toHaveValue('always');
  await enable(chat);
  await queue(chat, [tool('dsh_read', { path: 'a.txt' }), 'Denied; no file was read.']);
  await submit(chat);
  await expect(chat.getByRole('alertdialog')).toBeVisible();
  await expect(chat.getByLabel('Permissions', { exact: true })).toBeDisabled();
  expect(bridge.calls).toHaveLength(0);
  await chat.getByRole('button', { name: 'Deny', exact: true }).click();
  await complete(chat, worker);
  expect(bridge.calls).toHaveLength(0);

  bridge.confirmTools.add('dsh_write');
  await queue(chat, [tool('dsh_write', { path: 'package.json', content: '{}' }), 'Finished.']);
  await submit(chat, 'Write package.json');
  await expect(chat.getByRole('alertdialog')).toBeVisible();
  await chat.getByRole('button', { name: 'Allow once' }).click();
  await complete(chat, worker);
  expect(bridge.calls).toHaveLength(2);
  expect(bridge.applied).toHaveLength(1);
  expect(bridge.applied[0].confirmToken).toBe('fixture-confirm');

  await chat.getByLabel('Permissions', { exact: true }).selectOption('full');
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('permissionMode')).permissionMode)).toBe('full');
  await queue(chat, [tool('dsh_write', { path: 'package.json', content: '{"name":"fixture"}', permissionMode: 'always' }), 'Finished.']);
  await submit(chat, 'Update package.json');
  await complete(chat, worker);
  expect(bridge.applied).toHaveLength(2);
  expect(bridge.applied[1].permissionMode).toBe('full');
  await expect(chat.getByRole('alertdialog')).toBeHidden();
});

test('Stop cancels the send preview and preserves the user draft', async ({ chat, bridge, worker }) => {
  await enable(chat);
  await submit(chat, 'Preserve my draft');
  await expect(chat.locator('#dshpro-preview')).toBeVisible();
  await chat.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(chat.locator('#dshpro-phase')).toHaveText('Stopped');
  await expect(chat.locator('textarea').first()).toHaveValue('Preserve my draft');
  expect(bridge.calls).toHaveLength(0);
  expect((await checkpoint(chat, worker)).inProgress).toBe(true);
  expect(await chat.evaluate(() => (window as any).fixture.sent.length)).toBe(1);
});

test('disabling the agent restores native chat submission', async ({ chat, bridge }) => {
  await enable(chat);
  await chat.getByRole('button', { name: 'Disable agent', exact: true }).click();
  await expect(chat.locator('#dshpro-phase')).toHaveText('Disabled');
  await queue(chat, ['A native chat response.']);
  await submit(chat, 'Use DeepSeek normally');
  await expect.poll(() => chat.evaluate(() => (window as any).fixture.sent.at(-1))).toBe('Use DeepSeek normally');
  expect(bridge.calls).toHaveLength(0);
  await expect(chat.getByRole('button', { name: 'Enable agent', exact: true })).toBeEnabled();
});

test('approval requests reveal a collapsed panel without executing an unapproved tool', async ({ chat, bridge, worker }) => {
  await enable(chat);
  await chat.getByLabel('Permissions', { exact: true }).selectOption('always');
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('permissionMode')).permissionMode)).toBe('always');
  await queue(chat, [tool('dsh_read', { path: 'a.txt' }), 'Denied.']);
  await submit(chat);
  await chat.getByRole('button', { name: 'Collapse panel' }).click();
  await expect(chat.locator('#dshpro-body')).toBeHidden();
  await expect(chat.getByRole('alertdialog')).toBeVisible();
  expect(bridge.calls).toHaveLength(0);
  await chat.getByRole('button', { name: 'Deny', exact: true }).click();
  await complete(chat, worker);
});

test('reload offers explicit Resume and does not replay completed tools', async ({ chat, bridge, worker }) => {
  await enable(chat);
  await queue(chat, [tool('dsh_read', { path: 'read-once.txt' }), { hold: true, partial: 'Generating...' }]);
  await submit(chat);
  await chat.waitForFunction(() => (window as any).fixture.sent.length === 3);
  expect(bridge.applied).toHaveLength(1);
  await chat.reload();
  await expect(chat.locator('#dshpro-resume')).toBeVisible();
  await queue(chat, ['Finished after resuming.']);
  await chat.locator('#dshpro-resume').click();
  await complete(chat, worker);
  expect(bridge.applied).toHaveLength(1);
  expect(await chat.evaluate(() => (window as any).fixture.sent.length)).toBe(1);
});

test('Reset restores the iteration budget and Resume compacts large history without changing archived code', async ({ chat, bridge, worker }) => {
  const code = '  nested: ${{ steps.deployment.outputs.page_url }}\n'.repeat(3000);
  const key = 'dshpro:conversation:' + chat.url();
  await worker.evaluate(({ key, code }) => chrome.storage.local.set({ [key]: {
    revision: 0, iterationCount: 15, inProgress: true, conversationHistory: [
      { role: 'user', content: 'Repair the workflow and continue publishing.' },
      { role: 'assistant', content: code, raw: code, tool_calls: [{ tool: 'dsh_write', args: { path: 'workflow.yml', content: code } }] },
      { role: 'system', kind: 'tool-intent', tool: 'dsh_write', tool_call_id: 'old-write', args: { path: 'workflow.yml', content: code } },
      { role: 'tool', tool: 'dsh_write', tool_call_id: 'old-write', result: { ok: true } },
    ],
  } }), { key, code });
  await chat.reload();
  await chat.getByRole('button', { name: 'Reset budget' }).click();
  await expect.poll(async () => (await checkpoint(chat, worker)).iterationCount).toBe(0);
  await queue(chat, ['Finished after resuming.']);
  await chat.locator('#dshpro-resume').click();
  await complete(chat, worker);
  expect(bridge.calls).toHaveLength(0);
  const sent = await chat.evaluate(() => (window as any).fixture.sent);
  expect(sent).toHaveLength(1);
  expect(sent[0].length).toBeLessThan(200000);
  expect((await checkpoint(chat, worker)).conversationHistory[2].args.content).toBe(code);
});

test('malformed tool calls remain visible and recover with a small direct write', async ({ chat, bridge, worker }) => {
  await enable(chat);
  const bad = '⟦DSH⟧{"tool":"dsh_write","args":{"content":BROKEN' + 'x'.repeat(550) + '}}⟦/DSH⟧';
  await queue(chat, [bad, bad, tool('dsh_write', { path: 'index.html', content: '<p>Built.</p>' }), 'DSH:DONE:Built.']);
  await submit(chat, 'Build a landing page');
  await complete(chat, worker, 25_000);
  expect(bridge.applied.map((call) => call.tool)).toEqual(['dsh_write']);
  await chat.locator('#dshpro-parser-error summary').click();
  await expect(chat.locator('#dshpro-parser-error pre')).toContainText(bad.slice('⟦DSH⟧'.length, -'⟦/DSH⟧'.length));
  expect(await chat.evaluate(() => (window as any).fixture.sent[3])).toContain('chunk below 1.5 KB');
  expect(bridge.requests).not.toContain('GET /handoff/fixture-run');
});

test('incident fragments and placeholder output recover without false completion or partial execution', async ({ chat, bridge, worker }) => {
  await enable(chat);
  await queue(chat, ['⟦DS', 'text', tool('dsh_write', { path: 'report.md', content: 'First verified chunk.' }), 'DSH:DONE:Written.']);
  await submit(chat, 'Write the incident report');
  // Both rejected fragments can use the eight-second rendering grace, in
  // addition to the cancellable send previews and the final tool round trip.
  await complete(chat, worker, 45_000);
  expect(bridge.applied.map((call) => call.args.path)).toEqual(['report.md']);
  const saved = await checkpoint(chat, worker);
  expect(saved.conversationHistory.filter((entry: any) => entry.kind === 'parse-error')).toHaveLength(2);
  expect(saved.conversationHistory.find((entry: any) => entry.raw === 'text').parseErrors).toHaveLength(1);
});

test('Stop cancels an accepted handoff and background alarms track the run', async ({ chat, bridge, worker }) => {
  bridge.handoffStatus = 'running';
  await enable(chat);
  await queue(chat, [tool('dsh_handoff', { planText: 'Run a long task' })]);
  await submit(chat);
  await expect.poll(() => worker.evaluate(async () => (await chrome.alarms.getAll()).map((alarm) => alarm.name))).toContain('dshpro-poll');
  await chat.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(chat.locator('#dshpro-phase')).toHaveText('Stopped');
  expect(bridge.cancelled).toBe(true);
  expect(bridge.applied).toHaveLength(1);
});

test('uncertain POST outcomes pause and Resume never automatically repeats the operation', async ({ chat, bridge, worker }) => {
  bridge.dropTools.add('dsh_write');
  await enable(chat);
  await queue(chat, [tool('dsh_write', { path: 'once.txt', content: 'Already accepted' })]);
  await submit(chat, 'Write once.txt');
  await expect(chat.locator('#dshpro-phase')).toContainText('Paused:');
  await expect(chat.locator('#dshpro-resume')).toBeVisible();
  expect(bridge.applied).toHaveLength(1);
  await queue(chat, ['The previous operation may have executed. Inspect it before changing anything.']);
  await chat.locator('#dshpro-resume').click();
  await complete(chat, worker);
  expect(bridge.applied).toHaveLength(1);
  const saved = await checkpoint(chat, worker);
  expect(saved.conversationHistory.some((entry: any) => entry.kind === 'tool-intent')).toBe(true);
});

test('a competing tab cannot acquire an active conversation', async ({ chat, extension, bridge }) => {
  await enable(chat);
  await queue(chat, [{ hold: true, partial: 'Working...' }]);
  await submit(chat);
  await chat.waitForFunction(() => (window as any).fixture.generating);
  const other = await extension.newPage();
  await other.goto(chat.url());
  await expect(other.locator('#dshpro-connection')).toHaveText('CONNECTED');
  await other.locator('#dshpro-enable').click();
  await expect(other.locator('#dshpro-phase')).toContainText('another tab');
  expect(await other.evaluate(() => (window as any).fixture.sent.length)).toBe(0);
  await chat.getByRole('button', { name: 'Stop', exact: true }).click();
  expect(bridge.calls).toHaveLength(0);
});

test('first-send navigation moves the durable checkpoint to the permanent conversation URL', async ({ chat, worker }) => {
  await chat.goto('https://chat.deepseek.com/');
  await chat.evaluate(() => { (window as any).fixture.migrate = true; });
  await enable(chat);
  expect(chat.url()).toBe('https://chat.deepseek.com/a/chat/s/new-conversation');
  expect((await checkpoint(chat, worker)).stage).toBe('ready');
  expect(await worker.evaluate(async () => (await chrome.storage.local.get('dshpro:conversation:https://chat.deepseek.com/'))['dshpro:conversation:https://chat.deepseek.com/'])).toBeUndefined();
});

test('attachment-only submission is observed once and not resent', async ({ chat, bridge, worker }) => {
  await enable(chat);
  await queue(chat, [tool('dsh_read', { path: 'attachment-task.txt' }), 'Attached task finished.']);
  await chat.evaluate(() => {
    (window as any).fixture.nativeAttachment = true;
    document.querySelector('.ds-button--primary.ds-button--circle')!.classList.remove('ds-button--disabled');
  });
  await chat.locator('.ds-button--primary.ds-button--circle').click();
  await complete(chat, worker);
  expect(bridge.applied[0].args.path).toBe('attachment-task.txt');
  const sent = await chat.evaluate(() => (window as any).fixture.sent);
  expect(sent.filter((text: string) => text === '[native attachment]')).toHaveLength(1);
  expect(sent).toHaveLength(3);
});

test('missing Send controls use a verified Enter fallback and unacknowledged sends pause', async ({ chat, bridge, worker }) => {
  await chat.goto('https://chat.deepseek.com/a/chat/s/semantic-enter');
  await chat.locator('[data-testid="send-button"]').evaluate((element) => element.remove());
  await enable(chat);
  await expect(chat.locator('#dshpro-log')).toContainText('trying Enter once');
  await queue(chat, ['Done.']);
  await submit(chat, 'Simple task');
  await complete(chat, worker);
  await chat.evaluate(() => { (window as any).fixture.ignoreSend = true; });
  await submit(chat, 'Task with a broken send control');
  await expect(chat.locator('#dshpro-phase')).toContainText('Paused: DeepSeek did not accept');
  expect(bridge.calls).toHaveLength(0);
  await expect(chat.locator('textarea').first()).not.toHaveValue('');
});

test('MV3 service worker restarts retain configuration and saved conversation state', async ({ chat, worker, extension }) => {
  await enable(chat);
  await queue(chat, ['Finished.']);
  await submit(chat, 'A small task');
  await complete(chat, worker);
  const before = await checkpoint(chat, worker);
  const cdp = await extension.newCDPSession(chat);
  const versions: any[] = [];
  const latest = new Map<string, any>();
  cdp.on('ServiceWorker.workerVersionUpdated', ({ versions: updated }) => {
    versions.push(...updated);
    for (const version of updated) latest.set(version.versionId, version);
  });
  await cdp.send('ServiceWorker.enable');
  await expect.poll(() => versions.find((version) => version.scriptURL === worker.url() && version.runningStatus === 'running')).toBeTruthy();
  const version = versions.findLast((version) => version.scriptURL === worker.url() && version.runningStatus === 'running');
  await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  await expect.poll(() => latest.get(version.versionId)?.runningStatus).toBe('stopped');
  await chat.locator('#dshpro-test').click();
  // Chromium may retain the same debugger target when restarting a version, so
  // use lifecycle events rather than assuming Playwright creates a new Worker.
  await expect.poll(() => latest.get(version.versionId)?.runningStatus).toBe('running');
  const nextWorker = extension.serviceWorkers().find((candidate) => candidate.url() === worker.url())!;
  await expect(chat.locator('#dshpro-connection')).toHaveText('CONNECTED');
  expect(await checkpoint(chat, nextWorker)).toEqual(before);
  expect(await nextWorker.evaluate(async () => (await chrome.storage.local.get('token')).token)).toBe(TOKEN);
  await cdp.detach();
});

test('modern panel supports labeled settings, keyboard collapse, validation, and small screens', async ({ chat, worker }, info) => {
  await expect(chat.getByRole('region', { name: 'DeepDock Harness' })).toBeVisible();
  await chat.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(chat.getByLabel('Bridge token', { exact: true })).toHaveAttribute('type', 'password');
  await expect(chat.getByLabel('Bridge token', { exact: true })).toHaveValue('');
  await chat.getByLabel('Bridge address').fill('https://example.com');
  await chat.getByRole('button', { name: 'Save settings' }).click();
  await expect(chat.locator('#dshpro-settings-feedback')).toContainText('127.0.0.1');
  expect(await worker.evaluate(async () => (await chrome.storage.local.get('baseUrl')).baseUrl)).toMatch(/^http:\/\/127\.0\.0\.1:/);
  const address = await worker.evaluate(async () => (await chrome.storage.local.get('baseUrl')).baseUrl);
  await chat.getByLabel('Bridge address').fill(address);
  await chat.getByLabel('Iteration limit', { exact: true }).fill('25');
  await chat.getByRole('button', { name: 'Save settings' }).click();
  await expect(chat.locator('#dshpro-settings-feedback')).toContainText('Settings saved.');
  expect(await worker.evaluate(async () => (await chrome.storage.local.get('token')).token)).toBe(TOKEN);
  await chat.getByRole('button', { name: 'Settings', exact: true }).click();
  await chat.getByRole('button', { name: 'Collapse panel' }).focus();
  await chat.keyboard.press('Enter');
  await expect(chat.locator('#dshpro-body')).toBeHidden();
  await chat.getByRole('button', { name: 'Expand panel' }).press('Enter');
  await expect(chat.locator('#dshpro-body')).toBeVisible();
  await chat.screenshot({ path: info.outputPath('panel-desktop.png') });
  await chat.setViewportSize({ width: 360, height: 740 });
  const box = await chat.locator('#dshpro-panel').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  expect(box!.y + box!.height).toBeLessThanOrEqual(740);
  await chat.screenshot({ path: info.outputPath('panel-mobile.png') });
});

test('content reinjection disposes old listeners and keeps a single working harness', async ({ chat, extension, bridge, worker }) => {
  const cdp = await extension.newCDPSession(chat);
  const contexts: any[] = [];
  cdp.on('Runtime.executionContextCreated', ({ context }) => contexts.push(context));
  await cdp.send('Runtime.enable');
  const workerUrl = new URL(worker.url());
  const extensionOrigin = `${workerUrl.protocol}//${workerUrl.host}`;
  await expect.poll(() => contexts.find((context) => context.origin === extensionOrigin)).toBeTruthy();
  const world = contexts.find((context) => context.origin === extensionOrigin);
  const script = await readFile(new URL('../../../.output/chrome-mv3/content-scripts/content.js', import.meta.url), 'utf8');
  const result = await cdp.send('Runtime.evaluate', { expression: script, contextId: world.id });
  expect(result.exceptionDetails).toBeUndefined();
  await expect(chat.locator('#dshpro-panel')).toHaveCount(1);
  await expect(chat.locator('#dshpro-connection')).toHaveText('CONNECTED');
  await enable(chat);
  await queue(chat, [tool('dsh_read', { path: 'once-after-reload.txt' }), 'Finished.']);
  await submit(chat);
  await complete(chat, worker);
  expect(bridge.applied).toHaveLength(1);
  await cdp.detach();
});
