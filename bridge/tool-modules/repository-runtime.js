'use strict';
const fs = require('fs');
const path = require('path');
const { ToolError, validatePath, redact } = require('../guard');

function text(value, name, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new ToolError('E_ARGS_INVALID', `${name} must be a non-empty string without control characters (maximum ${max} characters)`);
  return value;
}
function identifier(value, name) {
  text(value, name, 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) || value === '.' || value === '..') throw new ToolError('E_ARGS_INVALID', `Invalid ${name}`);
  return value;
}
function githubRepository(value) {
  text(value, 'repository', 240);
  const parts = value.split('/');
  if (parts.length !== 2) throw new ToolError('E_ARGS_INVALID', 'repository must be an explicit OWNER/NAME');
  parts.forEach((part) => identifier(part, 'repository owner/name'));
  return value;
}
function githubRemote(value) {
  text(value, 'url', 500);
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+)$/.exec(value);
  if (!match) throw new ToolError('E_ARGS_INVALID', 'Use a GitHub HTTPS or SSH repository URL without embedded credentials, query strings, or fragments');
  githubRepository(match[1].replace(/\.git$/, ''));
  return value;
}

function createRepositoryRuntime(runCaptured) {
  function directory(ctx, args) {
    text(args.path, 'path');
    const { abs } = validatePath(ctx.config, ctx.workspace, args.path, true);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new ToolError('E_ARGS_INVALID', 'path must name an existing repository directory inside the workspace');
    return abs;
  }
  async function command(executable, args, cwd, { allowFailure = false } = {}) {
    const result = await runCaptured(executable, args, cwd, 25000, 65536, { env: {
      GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GH_PROMPT_DISABLED: '1',
      GH_HOST: 'github.com', GIT_LITERAL_PATHSPECS: '1',
      GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oStrictHostKeyChecking=yes',
      GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined,
    } });
    result.stdout ||= '';
    result.stderr ||= '';
    if (!allowFailure && (result.exitCode !== 0 || result.timedOut || result.spawnError)) {
      const code = result.timedOut ? 'E_TIMEOUT' : 'E_COMMAND_FAILED';
      const guidance = executable === 'gh' ? ' Install GitHub CLI if needed and run gh auth login on this machine.' : ' Check the repository, Git identity, and cached Git/GitHub authentication.';
      throw new ToolError(code, `${executable} ${args[0]} failed: ${redact(result.stderr || result.stdout).slice(0, 2000)}.${guidance}`, { exitCode: result.exitCode, timedOut: Boolean(result.timedOut), outcome: result.timedOut ? 'unknown; inspect before retrying' : 'failed' });
    }
    if (result.truncated) throw new ToolError('E_COMMAND_FAILED', `${executable} output exceeded the limit; narrow the requested file list`);
    return result;
  }
  async function repository(ctx, args) {
    const cwd = directory(ctx, args);
    const root = (await command('git', ['rev-parse', '--show-toplevel'], cwd)).stdout.trim();
    // Native canonical paths also expand Windows 8.3 aliases such as RUNNER~1.
    const actual = fs.realpathSync.native(root);
    const expected = fs.realpathSync.native(cwd);
    if (path.relative(expected, actual) !== '') throw new ToolError('E_ARGS_INVALID', 'path must be the repository root itself; refusing to operate on an ancestor repository. Initialize this project with dsh_git_init if needed.');
    return cwd;
  }
  async function branch(cwd, value) {
    const name = value === undefined ? (await command('git', ['symbolic-ref', '--short', 'HEAD'], cwd)).stdout.trim() : text(value, 'branch', 240);
    if (name.startsWith('-')) throw new ToolError('E_ARGS_INVALID', 'branch must not start with a dash');
    await command('git', ['check-ref-format', '--branch', name], cwd);
    return name;
  }
  return { directory, repository, command, branch };
}

module.exports = { createRepositoryRuntime, text, identifier, githubRepository, githubRemote };
