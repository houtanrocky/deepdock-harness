# Modular tools

`tools.js` constructs one registry from core handlers and the module factories in
`index.js`. The registry supplies both `GET /tools` and tool execution. Every call
retains the bridge's workspace validation, execution log, error response, and
confirmation-token flow. The extension discovers names and descriptions from
`GET /tools`; no extension allowlist needs updating when a module is added.

Add a factory to `index.js` that accepts dependencies and returns tool entries:

```js
module.exports = function exampleTools(dependencies) {
  return [{
    definition: {
      name: 'dsh_example',
      description: 'Describe the operation',
      params: { path: 'string Required workspace-relative project path' },
    },
    requiresConfirmation: true,
    async execute(ctx, args) {
      // Validate arguments and paths, then perform the operation.
      return { completed: true };
    },
  }];
};
```

`requiresConfirmation` can also be a predicate of `args` for mixed read/write
tools. The registry rejects duplicate names and invalid registrations. Modules
should inject subprocess/network dependencies for tests. Raise `ToolError` for
actionable failures; report partial completion explicitly when an external action
may have succeeded. Check confirmation before effects.

The extension's **Ask for important commands** mode prompts for module mutations.
**Full access** automatically satisfies confirmation-token requests. **Ask every
time** asks once before each call and reuses that approval if the bridge needs a
token. Tokens are single-use and bound to the tool, arguments, and workspace.
Full access also permits unrestricted shell syntax, including pipes and command
chains. Other modes retain the shell allowlist and blocked-command checks.
The background service derives the policy from the saved selector; a model cannot
select Full access by placing a policy value in its tool arguments.

## Git and GitHub

The `git.js` and `github.js` modules provide:

| Tool | Behavior |
| --- | --- |
| `dsh_git_init` | Initialize an explicit project directory, default branch `main`. |
| `dsh_git_add` | Stage an explicit `files` array after validating every selected path. |
| `dsh_git_commit` | Commit the staged index with a message; use the configured Git identity. |
| `dsh_git_remote` | List remotes, or `add` / `set-url` an explicit GitHub HTTPS or SSH URL. |
| `dsh_git_push` | Push the current or named local branch to a configured remote and set its upstream. |
| `dsh_github_status` | Check the authenticated GitHub account without returning a token. |
| `dsh_github_create` | Create explicit `OWNER/NAME`, default visibility `private`, and add a remote. |

All repository operations require `path`, a workspace-relative repository root.
An ancestor repository is rejected: a project inside `S:\Repos` cannot
accidentally commit or push `S:\Repos` itself. `dsh_git_init` initializes only the
directory named in `path`. Workspaces, credentials-file guards, and path escape
checks continue to apply. Broad staging fails before changing the index if it
would include a forbidden file; use an explicit file list or appropriate ignores.

Git operations use executable argument arrays with no shell. Push supports one
GitHub destination and one branch, without force or deletion flags. The remote
must exist explicitly; creation never invents an owner or project name. A
creation error includes the destination so a partially created repository can be
inspected before retrying.

Git uses existing credential helpers or SSH credentials. For HTTPS, the push tool
also supplies GitHub CLI as a per-request credential helper without changing
global Git configuration. GitHub CLI creation uses its stored authentication or
supported environment credentials. The bridge never asks the model for a token
and never writes a token into a remote URL. Credential prompts are disabled and
each subprocess has a 25-second deadline. A timeout can leave an uncertain
external outcome; inspect the remote before retrying.

If authentication is unavailable, install GitHub CLI and run `gh auth login` in a
terminal on this machine once. See the official [authentication manual](https://cli.github.com/manual/gh_auth_login).
The repository-creation implementation follows the official
[`gh repo create` options](https://cli.github.com/manual/gh_repo_create).

An existing committed project can be published in these steps:

```json
{"tool":"dsh_github_status","args":{}}
{"tool":"dsh_github_create","args":{"path":"my-project","repository":"OWNER/REPO","visibility":"private"}}
{"tool":"dsh_git_push","args":{"path":"my-project","remote":"origin","branch":"main"}}
```

For an existing GitHub repository, use `dsh_git_remote` with `action: "add"` and
the user-provided `url`, then `dsh_git_push`. For an uncommitted local project,
initialize if needed, stage explicit files, and commit first. Creation and push
are separate calls: `dsh_github_create` returns `pushed: false` and the next tool.

Run the local regression suite from the repository root:

```powershell
npm test
```

Git tests create temporary local repositories. GitHub creation and push use
injected subprocess results; the tests never create or push a real remote.
