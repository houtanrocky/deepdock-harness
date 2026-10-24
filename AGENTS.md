# Repository Guidelines

## Project Structure & Module Organization

`bridge/` contains the local Node.js HTTP service, security guards, handoff logic, and modular Git/GitHub tools. Keep tool modules in `bridge/tool-modules/` and register them through the existing registry contract documented in that directory. `extension/` contains the browser extension: background and content scripts, protocol handling, UI styles, selectors, and icons. Its tests and DOM fixtures are in `extension/test/`. `scripts/` holds Windows pairing and bridge start/stop helpers. Runtime configuration and logs are local state; do not commit them.

## Build, Test, and Development Commands

- `node --test extension/test/*.test.cjs` runs the Node test suite.
- `node bridge/build.js` runs the bridge build/validation script; inspect its output before packaging changes.
- `powershell -ExecutionPolicy Bypass -File scripts/start-bridge.ps1` starts the local bridge for development. `scripts/stop-dsh-pro.cmd` stops it.
- Load `extension/` as an unpacked extension in Edge or Chrome, then refresh `chat.deepseek.com` to manually verify UI and protocol changes.

## Coding Style & Naming Conventions

Use the repository’s existing JavaScript style: CommonJS modules in the bridge and tests, semicolon-terminated statements, and two-space indentation. Use descriptive `camelCase` names for functions and variables; tool names exposed to the extension use the `dsh_` prefix. Keep extension assets and browser-facing code in `extension/`, and bridge-only behavior in `bridge/`. No formatter or linter is configured, so match nearby code and keep changes focused.

## Testing Guidelines

Add or update `*.test.cjs` tests alongside related extension tests, and use the existing `node:test` and `node:assert` conventions. DOM behavior can use the fixtures in `extension/test/fixtures/`; Python harnesses are available for browser/DOM checks. Run the Node suite after changes to protocol, tool registration, history, or Git tools; manually exercise the unpacked extension for visible browser behavior.

## Commit & Pull Request Guidelines

Recent commits use short subject lines, often with a conventional prefix such as `feat:`; one recent subject is descriptive Chinese text. Keep subjects concise and imperative. Pull requests should explain user-visible behavior, list the checks run, link related issues when applicable, and include screenshots for UI changes. Call out configuration or security impact for bridge and permission changes.

## Security & Configuration

The bridge is intended to listen on `127.0.0.1` and authenticate extension requests with a local token. Never commit `bridge/config.json`, audit/runtime logs, credentials, or generated `.dsh-pro/` data. Keep workspace path validation and command safeguards intact when modifying file or shell tools.

## Development Roadmap

Before planning new features, read `docs/DEVELOPMENT-ROADMAP.md`. It records the agreed coding workflow priorities and their implementation status. Keep it updated when a listed capability changes or is completed.
