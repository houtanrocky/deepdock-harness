'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createToolRegistry } = require('../../bridge/tool-registry');
const { runTool, runCaptured, TOOL_DEFS } = require('../../bridge/tools');
const gitTools = require('../../bridge/tool-modules/git');
const githubTools = require('../../bridge/tool-modules/github');
const { githubRemote } = require('../../bridge/tool-modules/repository-runtime');

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-git-tools-'));
  t.after(() => {
    assert.equal(path.dirname(workspace), os.tmpdir());
    assert.ok(path.basename(workspace).startsWith('dsh-git-tools-'));
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  const project = path.join(workspace, 'project');
  fs.mkdirSync(project);
  const config = { allowedRoots: [workspace] };
  const ctx = { config, workspace, confirmed: true };
  return { workspace, project, ctx };
}
function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function initialized(t) {
  const f = fixture(t);
  await runTool('dsh_git_init', { path: 'project' }, f.ctx);
  git(f.project, 'config', 'user.name', 'DSH test');
  git(f.project, 'config', 'user.email', 'dsh-test@example.invalid');
  fs.writeFileSync(path.join(f.project, 'hello.txt'), 'Hello\n');
  await runTool('dsh_git_add', { path: 'project', files: ['hello.txt'] }, f.ctx);
  await runTool('dsh_git_commit', { path: 'project', message: 'Initial fixture' }, f.ctx);
  return f;
}
const success = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });

test('registry discovers modular tools and rejects duplicate registrations', async () => {
  assert.equal(new Set(TOOL_DEFS.map((tool) => tool.name)).size, TOOL_DEFS.length);
  for (const name of ['dsh_git_init', 'dsh_git_add', 'dsh_git_commit', 'dsh_git_remote', 'dsh_git_push', 'dsh_github_status', 'dsh_github_create']) assert.ok(TOOL_DEFS.some((tool) => tool.name === name));
  const entry = { definition: { name: 'dsh_example', description: 'Example', params: {} }, execute: async () => 'registered' };
  assert.equal(await createToolRegistry([[entry]]).execute('dsh_example', {}, {}), 'registered');
  assert.throws(() => createToolRegistry([[entry], [entry]]), /Duplicate tool registration/);
});

test('new Git mutations require approval; confirmed calls stage and commit without a shell', async (t) => {
  const f = fixture(t);
  await assert.rejects(runTool('dsh_git_init', { path: 'project' }, { ...f.ctx, confirmed: false }), (error) => error.code === 'E_NEEDS_CONFIRM');
  assert.equal(fs.existsSync(path.join(f.project, '.git')), false);
  await runTool('dsh_git_init', { path: 'project' }, f.ctx);
  git(f.project, 'config', 'user.name', 'DSH test');
  git(f.project, 'config', 'user.email', 'dsh-test@example.invalid');
  fs.writeFileSync(path.join(f.project, '--help'), 'literal file\n');
  await runTool('dsh_git_add', { path: 'project', files: ['--help'] }, f.ctx);
  const message = 'Keep "quotes" && $literal; text';
  const result = await runTool('dsh_git_commit', { path: 'project', message }, f.ctx);
  assert.equal(result.commit, git(f.project, 'rev-parse', 'HEAD'));
  assert.equal(git(f.project, 'log', '-1', '--format=%s'), message);
  assert.equal(git(f.project, 'show', 'HEAD:--help'), 'literal file');
  assert.equal(git(f.project, 'symbolic-ref', '--short', 'HEAD'), 'main');
});

test('Git operations refuse an ancestor repository and init targets only the explicit project', async (t) => {
  const f = fixture(t);
  git(f.workspace, 'init', '--initial-branch=parent');
  await assert.rejects(runTool('dsh_git_remote', { path: 'project' }, f.ctx), /repository root itself/);
  await runTool('dsh_git_init', { path: 'project' }, f.ctx);
  assert.equal(fs.realpathSync(git(f.project, 'rev-parse', '--show-toplevel')), fs.realpathSync(f.project));
  assert.equal(git(f.workspace, 'symbolic-ref', '--short', 'HEAD'), 'parent');
  await assert.rejects(runTool('dsh_git_init', { path: '../outside' }, f.ctx), (error) => error.code === 'E_PATH_ESCAPE');
});

test('directory staging validates every candidate before changing the index', async (t) => {
  const f = await initialized(t);
  fs.writeFileSync(path.join(f.project, '.env'), 'PRIVATE=fixture');
  fs.writeFileSync(path.join(f.project, 'safe.txt'), 'safe');
  await assert.rejects(runTool('dsh_git_add', { path: 'project', files: ['.'] }, f.ctx), (error) => error.code === 'E_FORBIDDEN_PATH');
  assert.equal(git(f.project, 'diff', '--cached', '--name-only'), '');
  await assert.rejects(runTool('dsh_git_add', { path: 'project', files: ['../other.txt'] }, f.ctx), (error) => error.code === 'E_PATH_ESCAPE');
});

test('remote configuration supports explicit GitHub URLs and rejects credentials and executable protocols', async (t) => {
  const f = await initialized(t);
  const args = { path: 'project', action: 'add', url: 'https://github.com/example/project.git' };
  await assert.rejects(runTool('dsh_git_remote', args, { ...f.ctx, confirmed: false }), (error) => error.code === 'E_NEEDS_CONFIRM');
  await runTool('dsh_git_remote', args, f.ctx);
  const listed = await runTool('dsh_git_remote', { path: 'project' }, { ...f.ctx, confirmed: false });
  assert.match(listed.remotes, /https:\/\/github.com\/example\/project.git/);
  await runTool('dsh_git_remote', { ...args, action: 'set-url', url: 'git@github.com:example/project.git' }, f.ctx);
  assert.equal(git(f.project, 'remote', 'get-url', 'origin'), 'git@github.com:example/project.git');
  for (const url of ['https://token@github.com/example/project.git', 'https://github.com/example/project?token=x', 'https://elsewhere.test/example/project', 'ext::bad', '--help']) assert.throws(() => githubRemote(url));
});

test('push uses the configured destination, a single branch, cached authentication, and no interactive stdin', async (t) => {
  const f = await initialized(t);
  git(f.project, 'remote', 'add', 'origin', 'https://github.com/example/project.git');
  const pushes = [];
  const captured = async (exe, args, cwd, timeout, max, options) => {
    if (exe === 'git' && args.includes('push')) {
      pushes.push({ exe, args, cwd, timeout, options });
      return success('Done');
    }
    return runCaptured(exe, args, cwd, timeout, max, options);
  };
  const registry = createToolRegistry([gitTools({ runCaptured: captured })]);
  await assert.rejects(registry.execute('dsh_git_push', { path: 'project' }, { ...f.ctx, confirmed: false }), (error) => error.code === 'E_NEEDS_CONFIRM');
  assert.equal(pushes.length, 0);
  const result = await registry.execute('dsh_git_push', { path: 'project' }, f.ctx);
  assert.equal(result.pushed, true);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].cwd, f.project);
  assert.deepEqual(pushes[0].args.slice(-3), ['--', 'origin', 'refs/heads/main:refs/heads/main']);
  assert.equal(pushes[0].options.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(pushes[0].options.env.GCM_INTERACTIVE, 'Never');
  assert.equal(pushes[0].options.shell, undefined);
  assert.equal(pushes[0].timeout, 25000);
  assert.ok(pushes[0].args.includes('credential.https://github.com.helper=!gh auth git-credential'));
  git(f.project, 'remote', 'set-url', 'origin', 'https://elsewhere.test/repo.git');
  await assert.rejects(registry.execute('dsh_git_push', { path: 'project' }, f.ctx), /GitHub HTTPS or SSH/);
  assert.equal(pushes.length, 1);
});

test('GitHub status checks account availability and never requests a token', async (t) => {
  const f = fixture(t);
  const calls = [];
  let installed = true;
  const registry = createToolRegistry([githubTools({ runCaptured: async (exe, args) => {
    calls.push({ exe, args });
    return installed ? success('{"login":"fixture-user"}') : { stdout: '', stderr: 'gh missing', exitCode: -1, spawnError: true };
  } })]);
  const ready = await registry.execute('dsh_github_status', {}, { ...f.ctx, confirmed: false });
  assert.equal(ready.authenticated, true);
  assert.equal(ready.login, 'fixture-user');
  assert.deepEqual(calls[0].args, ['api', 'user', '--jq', '{login: .login}']);
  installed = false;
  const missing = await registry.execute('dsh_github_status', {}, f.ctx);
  assert.equal(missing.installed, false);
  assert.equal(missing.authenticated, false);
  assert.match(missing.message, /gh auth login/);
});

test('repository creation requires explicit owner/name, defaults to private, and never guesses or pushes', async (t) => {
  const f = await initialized(t);
  const creates = [];
  const registry = createToolRegistry([githubTools({ runCaptured: async (exe, args, ...rest) => {
    if (exe !== 'gh') return runCaptured(exe, args, ...rest);
    creates.push(args);
    return success('https://github.com/example/new-project');
  } })]);
  const args = { path: 'project', repository: 'example/new-project' };
  await assert.rejects(registry.execute('dsh_github_create', args, { ...f.ctx, confirmed: false }), (error) => error.code === 'E_NEEDS_CONFIRM');
  assert.equal(creates.length, 0);
  await assert.rejects(registry.execute('dsh_github_create', { ...args, repository: 'guess-me' }, f.ctx), /explicit OWNER\/NAME/);
  const result = await registry.execute('dsh_github_create', args, f.ctx);
  assert.equal(result.url, 'https://github.com/example/new-project');
  assert.equal(result.visibility, 'private');
  assert.equal(result.nextTool, 'dsh_git_push');
  assert.equal(result.pushed, false);
  assert.deepEqual(creates[0], ['repo', 'create', 'example/new-project', '--private', '--source', f.project, '--remote', 'origin']);
  git(f.project, 'remote', 'add', 'origin', 'https://github.com/example/existing.git');
  await assert.rejects(registry.execute('dsh_github_create', args, f.ctx), /already exists/);
  assert.equal(creates.length, 1);
});

test('partial creation failures identify the destination and are never automatically retried', async (t) => {
  const f = await initialized(t);
  let attempts = 0;
  const registry = createToolRegistry([githubTools({ runCaptured: async (exe, args, ...rest) => {
    if (exe !== 'gh') return runCaptured(exe, args, ...rest);
    attempts++;
    return { stdout: '', stderr: 'network interrupted', exitCode: -1, timedOut: true };
  } })]);
  await assert.rejects(registry.execute('dsh_github_create', { path: 'project', repository: 'example/partial' }, f.ctx), (error) => {
    assert.equal(error.code, 'E_TIMEOUT');
    assert.match(error.message, /may have succeeded/);
    assert.equal(error.extra.url, 'https://github.com/example/partial');
    return true;
  });
  assert.equal(attempts, 1);
});
