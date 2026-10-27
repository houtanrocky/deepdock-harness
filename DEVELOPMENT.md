# Developing DeepDock Harness

Use Node.js 22.18 or newer and npm. The extension uses WXT 0.21 and Vite; the local bridge continues to use Node built-ins without runtime dependencies.

```powershell
npm ci
npm run dev
```

WXT launches a development browser and reloads the extension when source changes. To use your own browser, run `npm run dev:manual`, enable developer mode in Chrome or Edge, and load `.output/chrome-mv3-dev/` as an unpacked extension. Open `https://chat.deepseek.com`, pair with your bridge, and enable the agent. Stop an active task before editing its runtime; an extension reload requires reviewing the saved task and explicitly resuming it.

## Source layout

| Path | Responsibility |
| --- | --- |
| `extension/entrypoints/` | WXT lifecycle and browser entrypoints |
| `extension/src/harness.js` | One cancellable task loop, permissions, checkpoints, recovery |
| `extension/src/adapters/` | DeepSeek selectors, streaming detection, composer interaction |
| `extension/src/core/` | Pure protocol parsing and outbound transcript compaction |
| `extension/src/background.js` | MV3 message routing, serialized persistence, tab leases, bridge transport |
| `extension/src/contracts.ts` | Shared types, permission definitions, loopback URL validation |
| `extension/src/ui/` | Typed panel components and scoped CSS |
| `extension/public/icons/` | Static extension assets copied by WXT |
| `bridge/tool-modules/` | Local Git and GitHub tool implementations |
| `bridge/project-instructions.js` | Guarded discovery of scoped `AGENTS.md` files |
| `extension/test/` | Node regressions, browser tests, and chat fixtures |

The harness and adapter are ordinary ES modules with explicit dependencies. Unit tests import the same factories as the WXT entrypoints; they do not edit source strings to reach private functions. The retained JavaScript modules support gradual TypeScript adoption. Type checking currently covers WXT configuration, entrypoints, shared contracts, and the panel. Bridge modules remain CommonJS under `bridge/package.json`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Develop with WXT reloads |
| `npm run dev:manual` | Start the dev server without opening a browser |
| `npm run bridge` | Start the bridge after pairing/configuration |
| `npm run typecheck` | Generate WXT types and check TypeScript |
| `npm test` | Run parser, harness, permission, history, and bridge regressions |
| `npx playwright install chromium` | Install the browser needed by integration tests |
| `npm run test:e2e` | Build and test the unpacked MV3 extension in Chromium |
| `npm run check` | Type check, run regressions, then build and run browser tests |
| `npm run build` | Build production files in `.output/chrome-mv3/` |
| `npm run zip` | Create a distributable extension ZIP in `.output/` |

The public project site is a buildless page in `docs/`, published from `main` by `.github/workflows/pages.yml` to GitHub Pages. Keep its release links, privacy policy, and screenshots aligned with the release. `docs/assets/social-card.svg` is the source for the PNG social preview. GitHub Actions runs Windows regressions and Chromium integration checks on pushes and pull requests.

Read [the coding workflow roadmap](docs/DEVELOPMENT-ROADMAP.md) before planning new features, and keep its implementation status current.

## Project instructions and initialization

The chat command `/init` starts an agent task to inspect the selected workspace
and create or carefully update `AGENTS.md`; `/init relative/project` targets a
subproject. It uses the existing file tools, permissions, history, and Resume
behavior. Existing guidance is loaded before generation and must be preserved.

The bridge advertises `capabilities.projectInstructions` and serves guarded,
read-only discovery through `POST /instructions` and the registered
`dsh_instructions` tool. The harness refreshes root and previously discovered
guidance before prompts and checks paths from proposed tools before execution.
When new or changed rules are discovered, the whole proposed response is deferred
for model review, with no tools executed and no parse retry consumed. The exact
proposal remains saved, and compact history labels it unexecuted.

Guidance is included separately from compacted history and is reloaded on Resume.
Nested rules apply to their directory subtree; deeper rules override conflicting
ancestor rules there. Discovery never walks above an authorized workspace or
recursively searches it. Limits are 24 KiB per file and 48 KiB per discovery
request; oversized, binary, escaped, or unreadable instructions pause the task
instead of silently dropping rules. Prompt budgeting reserves room for guidance.
Ask every time requires approval for automatic instruction reads. Explicit
subdirectory shell/handoff work first uses `dsh_instructions`, since the harness
does not infer working directories from shell text. Older bridges keep the
file-tool workflow and report that automatic loading requires an update.

Browser tests load the production build in a temporary browser profile. They use actual extension storage, messaging, alarms, and service workers, with local chat fixtures and an authenticated HTTP fixture bridge on an ephemeral loopback port. They never contact DeepSeek, use your bridge configuration, execute your local tools, or publish repositories. Traces and screenshots for failed tests are in `test-results/`; the panel test also captures desktop and mobile screenshots on success.

## Runtime boundaries

Keep DOM changes in the adapter and rendering changes in the panel. Keep effects in the bridge, and register new tools through its registry. Preserve these invariants: record execution intent before a tool call; validate the entire response before running any call; never automatically retry a mutating POST after an uncertain outcome; require explicit Resume after a reload; take permission policy from saved user settings. Storage keys and protocol markers retain their existing names.

For browser changes, test semantic and observed DeepSeek layouts. For lifecycle changes, include reload, cancellation, competing tabs, and MV3 worker restarts. UI text must stay in English; model output and file payloads must retain their original bytes.

## Loading an existing installation

The product is now called DeepDock Harness. Existing `dsh_` tool names, DSH protocol markers, `dshpro:` storage keys, `.dsh-pro/` workspace data, and the `dsh-pro` bridge service identifier remain compatible. Windows configuration and logs stay under `%APPDATA%\DeepDock` to preserve existing pairing tokens and settings. Use `start-deepdock.cmd` and `stop-deepdock.cmd`; the older duplicate launcher names have been removed.

## Bridge scripts

`bridge.mjs` owns startup, authenticated shutdown, and pairing. The CMD launchers and `start-bridge.ps1` are small entrypoints into that shared controller; `pair.ps1` also copies the verified token to the clipboard. Repeating pairing reuses the saved token. Use `powershell -File scripts/pair.ps1 -RotateToken` to change it explicitly; an existing idle bridge is stopped before the file changes. Active work blocks rotation and restart. Stopping the bridge never kills unrelated agent processes.

| Script | Purpose |
| --- | --- |
| `start-deepdock.cmd` | Start or refresh the idle bridge |
| `stop-deepdock.cmd` | Shut down source and installed bridges using each saved configuration |
| `pair.ps1` | Verify pairing and copy the saved token; `-RotateToken` explicitly changes it |
| `start-bridge.ps1` | PowerShell entrypoint for start, or stop with `-Stop` |
| `bridge.mjs` | Shared implementation used by all launchers |
| `dev-manual.mjs` | WXT development server without opening a browser |

A 401 from a bridge started before these fixes means the running process has an older token than the configuration file. Stop tasks, close that bridge console, then run `start-deepdock.cmd`. The controller reports this mismatch without changing credentials or killing a process whose active work it cannot inspect. After pairing succeeds, paste the copied token into the extension Settings.

For installed bridges, use the native desktop app's **Bridge** and **Help & setup**
tabs. Opening the app leaves the bridge stopped; it has no startup registration.
The tray menu exposes the same controls. **Exit** stops the bridge before closing.
If authenticated shutdown cannot reach a frozen or legacy bridge, **Force stop
bridge...** shows the detected process paths and confirms interruption. Recovery
checks the Node entrypoint, PID, Windows account, and creation time. It also finds
older DeepDock bridges using the configured loopback port, including a different
install folder or system Node runtime, by verifying their server code and port
ownership. Bridges on other ports and unrelated services are excluded. Recovery
does not rely on an HTTP shutdown endpoint or a matching token. See the
[installer guide](scripts/installer/README.md) for building and testing the app.

Finish or stop active tasks in the old extension, then disable it before loading the WXT build. Chrome assigns unpacked extension identities by their load path, so `.output/chrome-mv3/` has separate storage from the old `extension/` directory and from the development build. Run `pair.ps1` to verify the bridge and copy its existing token; only `-RotateToken` changes an existing pairing. Do not run both extensions in the same chat.

If you need to retain old transcripts, export `await chrome.storage.local.get(null)` from the old extension's service-worker DevTools before removing it. In the new extension's service-worker DevTools, restore the reviewed object with `await chrome.storage.local.set(backup)`. Treat that backup as a credential because it can contain the bridge token. Do not transfer `chrome.storage.session` leases or active alarm state; review unfinished work before resuming.
