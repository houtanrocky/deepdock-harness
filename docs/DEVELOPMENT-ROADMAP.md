# Coding workflow roadmap

This document preserves the feature priorities agreed during development on
2026-10-24. Use it as a reference when planning future work. Keep status and scope
current as features land; entries describe product capabilities, rather than
one-off actions an agent can perform through the shell.

| Priority | Feature | Intended coding benefit | Status |
| --- | --- | --- | --- |
| 1 | Automatic project instructions and `/init` | Generate project-specific `AGENTS.md` guidance and apply root and scoped instructions automatically. | Implemented; see scope below. |
| 2 | Patch tool for multiple files | Preview and validate coordinated edits before writing, reducing fragile replacements and whole-file rewrites. | Planned |
| 3 | Managed terminal sessions | Start, monitor, and stop long-running commands and development servers, with streaming output. | Planned |
| 4 | Structured test results | Expose failed tests, source locations, and error details; rerun individual failures and track fixes. | Planned |
| 5 | Completion checks | Configure required build, test, and type checks and show their results before task completion. | Planned |
| 6 | Undo agent changes | Selectively restore task checkpoints while detecting later user edits and preserving unrelated work. | Planned |
| 7 | Code navigation and diagnostics | Find definitions and references, read compiler diagnostics, and rename symbols through language servers. | Planned |
| 8 | Better repository search | Respect ignore rules, add file globs and surrounding context, and paginate results. | Planned |
| 9 | Persistent task plans and decisions | Preserve visible checklists, acceptance criteria, and decisions through compaction and Resume. | Planned |
| 10 | Browser verification tools | Exercise the user's application and inspect screenshots, console errors, network failures, and traces. | Planned |
| 11 | Isolated task branches and worktrees | Keep task changes and unfinished experiments in separate branches and working directories. | Planned |
| 12 | Pull request and CI workflow | Create draft PRs, inspect CI failures, read reviews, and prepare follow-up changes through dedicated tools. | Planned |

## Project instructions scope

- `/init` inspects the selected workspace and asks the agent to create or carefully
  update its `AGENTS.md`. `/init relative/project` targets a subproject. Existing
  user guidance must be preserved and generated commands must match the project.
- Updated bridges advertise automatic discovery. The harness loads root guidance
  before each task and refreshes applicable instructions as work proceeds.
- Nested `AGENTS.md` files apply only within their directory subtree. Deeper
  guidance overrides conflicting ancestor guidance in that subtree. Explicit user
  requests and existing permission/path guards retain precedence.
- Newly discovered or changed instructions are shown to the agent before proposed
  tools execute. Resume reloads current files, and compaction does not remove the
  current instruction context.
- Shell commands and handoffs targeting subdirectories must first request their
  scoped instructions with `dsh_instructions`; shell command text is not parsed
  to guess working directories.
- Discovery stays within the selected authorized workspace and uses bounded text
  reads. Ask every time also applies to automatic instruction reads. Older bridges
  retain ordinary file-tool access and report that automatic loading needs an update.

## Suggested delivery order

Additional implemented workflow improvements:
Windows bridge lifecycle and pairing: the installer now provides a native desktop
app with Bridge and Help tabs, tray controls, explicit Start/Stop, token copying,
and confirmed recovery for frozen legacy processes, including source-launched
bridges on the configured port with a different runtime or token. Installation no longer starts
the bridge or registers startup; upgrades remove the old startup shortcut. The
source stop script also finds installed configurations. The harness includes
visible pairing guidance, a direct Settings > Bridge token action, and a Help tab.

Configurable tool-result pacing (two seconds by default, cancellable with Stop
and preserved on Resume), and a default iteration budget of 30. Saved user
iteration limits remain unchanged.

Tool text integrity: the harness requests fenced literal tool blocks, detects
rendered Markdown/math within tool calls, and rejects the entire affected response
before execution. Recovery requests literal raw arguments with a fence longer
than any backtick run in the payload. File paths containing control characters
receive an explicit JSON-escaping diagnostic. Successful chunked writes can use
the returned hash for the next append, followed by a final readback. `DSH_TOOL`
wrapper variants receive ordinary tool validation and recovery, and saved tasks
falsely completed on tool markup offer Resume without replaying the proposal. See
[the October 25 log analysis](LOG-ANALYSIS-2026-10-25.md).

After project instructions, prioritize the patch tool and managed terminal
sessions. Follow those with structured test results and completion checks, so
editing and verification become dependable before adding broader integrations.

## Implementation references

- [Language Server Protocol](https://microsoft.github.io/language-server-protocol/)
  for language-aware navigation and diagnostics.
- [Git worktree documentation](https://git-scm.com/docs/git-worktree.html) for task
  isolation.
- [Playwright trace viewer](https://playwright.dev/docs/trace-viewer) for reviewable
  browser verification.
