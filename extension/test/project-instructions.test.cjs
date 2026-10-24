'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readProjectInstructions } = require('../../bridge/project-instructions');
const { runTool } = require('../../bridge/tools');
const { initCommand, initMessage, projectInstructionsMessage } = require('../src/core/project-context.js');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-instructions-'));
  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(workspace);
  t.after(() => {
    assert.equal(path.dirname(base), os.tmpdir());
    assert.ok(path.basename(base).startsWith('dsh-instructions-'));
    fs.rmSync(base, { recursive: true, force: true });
  });
  const config = { allowedRoots: [workspace] };
  function write(file, content) {
    const abs = path.join(workspace, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return { base, workspace, config, write, load: (paths) => readProjectInstructions(config, workspace, paths) };
}

test('instructions follow root-to-target scope without sibling or outside-project guidance', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.base, 'AGENTS.md'), 'Outside workspace');
  f.write('AGENTS.md', 'Root rules');
  f.write('src/AGENTS.md', 'Source rules');
  f.write('src/ui/AGENTS.md', 'UI rules');
  f.write('other/AGENTS.md', 'Unrelated sibling');
  const data = f.load(['src/ui/new.js', 'src/another.js']);
  assert.deepEqual(data.instructions.map((entry) => [entry.path, entry.scope, entry.content]), [
    ['AGENTS.md', '.', 'Root rules'], ['src/AGENTS.md', 'src', 'Source rules'], ['src/ui/AGENTS.md', 'src/ui', 'UI rules'],
  ]);
  assert.equal(data.workspace, f.workspace);
  assert.equal(data.instructions[0].sha256.length, 64);
  assert.deepEqual(f.load(['other']).instructions.map((entry) => entry.path), ['AGENTS.md', 'other/AGENTS.md']);
});

test('missing instructions are ordinary, and edits and deletions are seen on the next load', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.load().instructions, []);
  f.write('AGENTS.md', '\uFEFFFirst version');
  const first = f.load().instructions[0];
  assert.equal(first.content, 'First version');
  f.write('AGENTS.md', 'Second version');
  assert.notEqual(f.load().instructions[0].sha256, first.sha256);
  fs.unlinkSync(path.join(f.workspace, 'AGENTS.md'));
  assert.deepEqual(f.load().instructions, []);
  assert.deepEqual(f.load(['new/folder/file.js']).checkedFiles, ['AGENTS.md', 'new/AGENTS.md', 'new/folder/AGENTS.md']);
});

test('instruction discovery keeps path guards and rejects invalid or oversized guidance', (t) => {
  const f = fixture(t);
  for (const paths of [[], Array(65).fill('.'), '.', [null]]) assert.throws(() => f.load(paths), (error) => error.code === 'E_ARGS_INVALID');
  for (const target of ['../outside', path.join(f.base, 'outside')]) assert.throws(() => f.load([target]), (error) => error.code === 'E_PATH_ESCAPE');
  const outside = path.join(f.base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'AGENTS.md'), 'Never expose outside rules');
  fs.symlinkSync(outside, path.join(f.workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.load(['linked/file.js']), (error) => error.code === 'E_SYMLINK_ESCAPE');
  f.write('AGENTS.md', Buffer.from([0, 1, 2]));
  assert.throws(() => f.load(), (error) => error.code === 'E_BINARY_FILE');
  f.write('AGENTS.md', 'x'.repeat(24 * 1024 + 1));
  assert.throws(() => f.load(), /context limit/);
});

test('the registered instruction tool uses the same guarded discovery', async (t) => {
  const f = fixture(t);
  f.write('project/AGENTS.md', 'Use the project test command');
  const result = await runTool('dsh_instructions', { paths: ['project'] }, { config: f.config, workspace: f.workspace });
  assert.equal(result.instructions[0].content, 'Use the project test command');
  assert.match(result.logFile, /execution-log/);
});

test('/init is a standalone command with an optional directory and preserves existing guidance', () => {
  assert.deepEqual(initCommand('/init'), { directory: '.', target: 'AGENTS.md' });
  assert.deepEqual(initCommand(' /init "demo project" '), { directory: 'demo project', target: 'demo project/AGENTS.md' });
  assert.deepEqual(initCommand('/init demo14\\'), { directory: 'demo14', target: 'demo14/AGENTS.md' });
  for (const task of ['Initialize this project', '/initial', 'Please run /init', '/init\nThen publish it']) assert.equal(initCommand(task), null);
  const message = initMessage(initCommand('/init demo14'));
  assert.match(message, /demo14\/AGENTS.md/);
  assert.match(message, /Preserve user-authored rules/);
  assert.match(message, /do not invent commands/);
  assert.match(message, /Read back the completed file/);
  assert.equal(initMessage(null), '');
  assert.match(projectInstructionsMessage([{ workspace: 'C:/project', scope: 'src', content: 'Rules' }]), /nested files override/);
});
