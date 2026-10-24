'use strict';
const fs = require('fs');
const path = require('path');
const { ToolError, validatePath, redact } = require('../guard');
const { createRepositoryRuntime, text, identifier, githubRemote } = require('./repository-runtime');

module.exports = function gitTools({ runCaptured }) {
  const runtime = createRepositoryRuntime(runCaptured);
  return [
    {
      definition: { name: 'dsh_git_init', description: 'Initialize Git in an explicit project directory', params: { path: 'string Required workspace-relative project directory', branch: 'string? default main' } },
      requiresConfirmation: true,
      async execute(ctx, args) {
        const cwd = runtime.directory(ctx, args);
        const branch = await runtime.branch(cwd, args.branch || 'main');
        if (fs.existsSync(path.join(cwd, '.git'))) throw new ToolError('E_ARGS_INVALID', 'This project already has Git metadata; inspect it with dsh_git_status');
        const result = await runtime.command('git', ['init', '--initial-branch=' + branch], cwd);
        return { path: args.path, branch, stdout: redact(result.stdout) };
      },
    },
    {
      definition: { name: 'dsh_git_add', description: 'Stage an explicit list of project files for a commit', params: { path: 'string Required repository root', files: 'string[] Repository-relative files or directories; excludes credentials via workspace guards' } },
      requiresConfirmation: true,
      async execute(ctx, args) {
        const cwd = await runtime.repository(ctx, args);
        if (!Array.isArray(args.files) || !args.files.length || args.files.length > 200) throw new ToolError('E_ARGS_INVALID', 'files must contain 1-200 repository-relative paths');
        for (const file of args.files) {
          text(file, 'files entry');
          if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new ToolError('E_PATH_ESCAPE', 'Staged files must stay inside the repository');
          validatePath(ctx.config, ctx.workspace, path.join(args.path, file), false);
        }
        // Expand directory selections before staging, so credentials cannot be
        // hidden inside a broad path such as ".". -- prevents option injection.
        const candidates = await runtime.command('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...args.files], cwd);
        for (const file of candidates.stdout.split('\0').filter(Boolean)) validatePath(ctx.config, ctx.workspace, path.join(args.path, file), false);
        await runtime.command('git', ['add', '--', ...args.files], cwd);
        return { path: args.path, files: args.files, staged: true };
      },
    },
    {
      definition: { name: 'dsh_git_commit', description: 'Commit the currently staged changes without changing Git identity', params: { path: 'string Required repository root', message: 'string Commit message' } },
      requiresConfirmation: true,
      async execute(ctx, args) {
        const cwd = await runtime.repository(ctx, args);
        const message = text(args.message, 'message');
        const result = await runtime.command('git', ['commit', '-m', message], cwd);
        const commit = (await runtime.command('git', ['rev-parse', 'HEAD'], cwd)).stdout.trim();
        return { path: args.path, commit, stdout: redact(result.stdout) };
      },
    },
    {
      definition: { name: 'dsh_git_remote', description: 'List remotes or explicitly add/update a GitHub remote', params: { path: 'string Required repository root', action: 'string? list (default), add, or set-url', remote: 'string? default origin', url: 'string? GitHub HTTPS/SSH URL required for add/set-url' } },
      requiresConfirmation: (args) => (args.action || 'list') !== 'list',
      async execute(ctx, args) {
        const cwd = await runtime.repository(ctx, args);
        const action = args.action || 'list';
        if (!['list', 'add', 'set-url'].includes(action)) throw new ToolError('E_ARGS_INVALID', 'action must be list, add, or set-url');
        if (action === 'list') return { remotes: redact((await runtime.command('git', ['remote', '-v'], cwd)).stdout) };
        const remote = identifier(args.remote || 'origin', 'remote');
        const url = githubRemote(args.url);
        await runtime.command('git', ['remote', action, remote, url], cwd);
        return { remote, url, updated: true };
      },
    },
    {
      definition: { name: 'dsh_git_push', description: 'Push a branch to an explicit configured GitHub remote using existing authentication; no force push or deletion', params: { path: 'string Required repository root', remote: 'string? default origin', branch: 'string? default current local branch' } },
      requiresConfirmation: true,
      async execute(ctx, args) {
        const cwd = await runtime.repository(ctx, args);
        const remote = identifier(args.remote || 'origin', 'remote');
        const branch = await runtime.branch(cwd, args.branch);
        const urls = (await runtime.command('git', ['remote', 'get-url', '--push', '--all', remote], cwd)).stdout.trim().split(/\r?\n/);
        if (urls.length !== 1) throw new ToolError('E_ARGS_INVALID', 'The selected remote must have exactly one explicit push URL');
        const url = githubRemote(urls[0]);
        // Add gh as a per-request credential helper. Existing helpers still work;
        // no token is read into the model or written into the repository URL.
        const config = url.startsWith('https:') ? ['-c', 'credential.https://github.com.helper=!gh auth git-credential'] : [];
        const result = await runtime.command('git', [...config, 'push', '--porcelain', '--set-upstream', '--', remote, `refs/heads/${branch}:refs/heads/${branch}`], cwd);
        return { remote, url, branch, pushed: true, stdout: redact(result.stdout) };
      },
    },
  ];
};
