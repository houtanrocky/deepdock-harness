'use strict';
const { ToolError, redact } = require('../guard');
const { createRepositoryRuntime, githubRepository, identifier, text } = require('./repository-runtime');

module.exports = function githubTools({ runCaptured }) {
  const runtime = createRepositoryRuntime(runCaptured);
  return [
    {
      definition: { name: 'dsh_github_status', description: 'Check GitHub CLI authentication and return the active account without exposing credentials', params: {} },
      async execute(ctx) {
        const cwd = runtime.directory(ctx, { path: '.' });
        const result = await runtime.command('gh', ['api', 'user', '--jq', '{login: .login}'], cwd, { allowFailure: true });
        if (result.exitCode !== 0) return { installed: !result.spawnError, authenticated: false, message: 'Install GitHub CLI if needed, then run gh auth login on this machine.', detail: redact(result.stderr).slice(0, 1500) };
        return { installed: true, authenticated: true, ...JSON.parse(result.stdout) };
      },
    },
    {
      definition: { name: 'dsh_github_create', description: 'Create an explicitly named GitHub repository and connect a local repo; use dsh_git_push afterward to publish commits', params: { path: 'string Required existing repository root', repository: 'string Required OWNER/NAME; do not guess the destination', visibility: 'string? private (default) or public', remote: 'string? default origin', description: 'string? Repository description' } },
      requiresConfirmation: true,
      async execute(ctx, args) {
        const cwd = await runtime.repository(ctx, args);
        const repository = githubRepository(args.repository);
        const visibility = args.visibility || 'private';
        if (!['private', 'public'].includes(visibility)) throw new ToolError('E_ARGS_INVALID', 'visibility must be private or public');
        const remote = identifier(args.remote || 'origin', 'remote');
        if (args.description !== undefined) text(args.description, 'description', 1000);
        const remotes = (await runtime.command('git', ['remote'], cwd)).stdout.trim().split(/\r?\n/);
        if (remotes.includes(remote)) throw new ToolError('E_ARGS_INVALID', `Remote ${remote} already exists. Inspect it with dsh_git_remote or choose a different remote name before creating a repository.`);
        const command = ['repo', 'create', repository, '--' + visibility, '--source', cwd, '--remote', remote];
        if (args.description !== undefined) command.push('--description', args.description);
        try {
          await runtime.command('gh', command, cwd);
        } catch (error) {
          throw new ToolError(error.code || 'E_COMMAND_FAILED', error.message + ' Repository creation may have succeeded before a later step failed. Inspect https://github.com/' + repository + ' and local remotes before retrying.', { ...error.extra, repository, url: 'https://github.com/' + repository });
        }
        return { repository, url: 'https://github.com/' + repository, visibility, remote, pushed: false, nextTool: 'dsh_git_push' };
      },
    },
  ];
};
