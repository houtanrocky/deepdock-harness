# Changelog

## Unreleased

- Add a configurable tool-result delay, defaulting to two seconds, with cancellable waiting and saved-result recovery on Resume.
- Increase the default iteration limit to 30 while preserving explicitly saved limits.
- Add `/init` to inspect a workspace or subproject and create or carefully update its `AGENTS.md`.
- Automatically load and refresh applicable root and nested project instructions before coding actions, including after Resume.
- Add the read-only `dsh_instructions` tool and preserve the agreed feature priorities in the development roadmap.

## 0.2.3 — 2026-10-24

- Report excessive tool calls as a call-limit error and explain that the entire rejected response was not executed.
- Mark rejected responses in compact history without presenting their partially parsed calls as pending actions.
- Recommend raw argument blocks after automatic JSON repair to help prevent repeated escaping errors.
- Log successful JSON repair only after the entire response passes validation.

## 0.2.2 — 2026-10-24

- Replace the duck with an original blue whale mark across the extension icons, panel, website, and store graphics.
- Add a complete Chrome Web Store artwork set: five screenshots, a small promotional tile, and a marquee, with format and size validation.
- Supply copy-ready listing fields, description, permission justifications, and privacy checkbox answers.
- Clarify task activity and optional GitHub username handling in the privacy disclosures.

## 0.2.1 — 2026-10-24

First public release of **DeepDock Harness**.

- A WXT-built Chrome and Edge extension connecting DeepSeek Chat to 17 local workspace tools.
- Task activity, file diffs, workspace selection, saved permission modes, cancellation, and explicit recovery from conversation checkpoints.
- Authenticated loopback bridge with file, search, shell, Git, and GitHub tools, plus optional local agent handoff.
- Windows x64 bridge installer with a bundled Node.js runtime and complete tool-module packaging.
- Native Windows path comparison for Git operations, including workspaces reached through short-path aliases.
- Consistent DeepDock Harness branding, a public project website, privacy information, and contributor guides.
- Windows regression checks and Chromium extension integration in GitHub Actions.

The browser extension is version 0.2.1. The companion bridge installer is version 0.1.0. Existing protocol identifiers and configuration locations remain compatible.
