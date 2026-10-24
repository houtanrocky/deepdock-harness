# DeepDock

A browser agent harness for the DeepSeek web UI. Give it a task in chat, and it can use local file, search, shell, Git, and GitHub tools through an authenticated loopback bridge. Longer tasks can be handed to DeepSeek Harness (`dsh --profile headless`).

The extension now builds with **WXT** and includes a redesigned panel with task status, an iteration budget, workspace selection, saved permission modes, and connection settings. It runs one cancellable tool loop per conversation and saves checkpoints for explicit recovery.

```text
DeepSeek chat → extension harness → local bridge → workspace tools
                      ↓                   └── DeepSeek Harness handoff
             conversation checkpoints
```

## Install and run

Requires Node.js **22.18+**, npm, and Chrome or Edge **120+**. Install and authenticate DeepSeek Harness separately if you want local agent handoff. Git tools require Git; GitHub creation and publishing use your existing Git/SSH credentials and GitHub CLI authentication (`gh auth login`).

```powershell
npm ci
npm run build
```

1. Pair and start the bridge with `powershell -ExecutionPolicy Bypass -File scripts/pair.ps1`. This reuses an existing local token or creates one on first use, verifies the bridge, and copies the token to the clipboard. Configure workspace roots and the optional `dshBin` in the ignored `bridge/config.json`.
2. Open `chrome://extensions` or `edge://extensions`, turn on developer mode, and load **`.output/chrome-mv3/`** as an unpacked extension.
3. Open `https://chat.deepseek.com`. In the DeepDock panel, open **Settings**, paste the bridge token, and save. The bridge address defaults to `http://127.0.0.1:8765`.
4. Click **Test connection**, then **Enable agent**. Once DeepSeek confirms the protocol, send your task through its normal composer.

For a Windows installer that bundles Node.js and starts the bridge in the background, see [the installer build guide](scripts/installer/README.md). The installer asks you to choose a project folder and copies the pairing token to the clipboard. The browser extension is distributed separately.

For daily use, `scripts/start-deepdock.cmd` starts or refreshes an idle bridge and `scripts/stop-deepdock.cmd` stops it. The extension must remain open in the conversation while it interacts with DeepSeek. Use **Stop** to cancel a task and **Disable agent** to return to ordinary chat. A page reload offers **Resume unfinished task** and never silently reruns tools.

Pairing is safe to repeat. To explicitly rotate the token, run `powershell -File scripts/pair.ps1 -RotateToken`; this refuses to interrupt active work and restarts an idle bridge with the new token. See [bridge scripts and token mismatch recovery](DEVELOPMENT.md#bridge-scripts) for older installations.

**Upgrading from the original extension:** finish or stop tasks and disable the legacy extension before loading the WXT output. The new load path gets separate browser storage. Reuse your existing bridge token; see [installation migration and transcript transfer](DEVELOPMENT.md#loading-an-existing-installation) if you want to retain saved conversations. Development and production builds also use separate extension identities.

## Develop

```powershell
npm run dev       # WXT development browser and extension reloads
npm run typecheck # WXT types and TypeScript checks
npm test          # Node regression suite
npx playwright install chromium
npm run test:e2e  # Build and exercise the actual MV3 extension in Chromium
npm run zip       # Distributable ZIP in .output/
```

Load `.output/chrome-mv3-dev/` manually when running `npm run dev:manual`. Load `.output/chrome-mv3/` for normal use. The source directory `extension/` is no longer an unpacked extension.

See [DEVELOPMENT.md](DEVELOPMENT.md) for source layout, test details, and runtime invariants, and [extension/HARNESS.md](extension/HARNESS.md) for protocol and recovery behavior.

## Permissions and recovery

The saved permission selector controls execution policy:

- **Ask for important commands** is the default. Sensitive changes and commands outside the safe list need approval.
- **Ask every time** asks before every tool, including reads. An approval is reused if the bridge also requires a confirmation token.
- **Full access** runs tools and unrestricted shell commands without approval prompts. Direct file tools retain their path checks.

The model cannot change the saved permission policy through tool arguments. A handoff approval covers starting that local agent; the local agent's configuration controls its internal actions.

The harness validates all calls in a response before executing any. It records execution intent before an effect, preserves results, and does not automatically retry tool POST requests after an uncertain outcome. If a crash interrupts a request, review the workspace before resuming; exactly-once execution is not guaranteed. Reset restores the iteration budget while preserving history and results.

## Tools

| Area | Tools |
| --- | --- |
| Files and search | `dsh_tree`, `dsh_read`, `dsh_write`, `dsh_edit`, `dsh_search` |
| Commands and inspection | `dsh_bash`, `dsh_git_status`, `dsh_git_diff`, `dsh_log` |
| Local agent | `dsh_handoff` |
| Git and GitHub | `dsh_git_init`, `dsh_git_add`, `dsh_git_commit`, `dsh_git_remote`, `dsh_git_push`, `dsh_github_status`, `dsh_github_create` |

The extension discovers tool definitions from the bridge. See the [module registration and GitHub workflow guide](bridge/tool-modules/README.md) to add tools. GitHub creation and pushing are separate operations, and new repository destinations must use an explicit owner and name.

File paths are relative to an allowed workspace. Reads support line offsets and limits; writes and edits support content hashes to prevent stale edits. Large outputs are saved under the workspace's `.dsh-pro/outputs/`. Execution logs and handoff artifacts live under `.dsh-pro/`; bridge auditing is written to `bridge/audit.jsonl` during development and `%APPDATA%\DeepDock\audit.jsonl` in the Windows installation.

## Configuration and boundaries

The bridge listens on `127.0.0.1` with Bearer authentication. `bridge/config.json`, credentials, logs, and generated `.dsh-pro/` files are local state and must stay out of Git. The extension accepts only a loopback HTTP bridge URL; changing its port does not require rebuilding.

Direct file tools validate workspace boundaries and block path escapes and credential files. Full access shell commands and local agent handoffs have broader capabilities, so choose the permission mode deliberately. Use one active harness per workspace to avoid conflicting edits.

DeepSeek has no public DOM contract. If its layout changes, use **Diagnostics** and optionally override selectors in **Settings → Advanced selectors**, or update `extension/src/adapters/`. Browser integration tests use local chat fixtures and a fixture bridge; they do not certify the current live DeepSeek site or send messages to your account.

Automatic chat interaction can trigger service limits. Outgoing sends retain the cancellable two-second preview, throttling, and daily limit. The full transcript stays local; only a bounded view is sent with each continuation.
