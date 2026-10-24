# DeepDock Harness

Build with `npm run build`, load `.output/chrome-mv3/` as an unpacked extension,
refresh DeepSeek, and click **Enable agent**. While
enabled, sending a task through the chat composer starts one asynchronous loop:

1. Persist the user message and send a compact view of the accumulated transcript.
2. Observe the assistant DOM until streaming ends.
3. Parse and validate every tool call before executing any call from that turn.
4. Execute calls sequentially, persist each result, and send the updated transcript.
5. Finish on a response with no tool calls, or pause on Stop, a failure, or the
   hard iteration limit (15 by default, configurable from 1 to 1000 in Settings).

`src/harness.js` owns the cancellable async loop and `src/adapters/deepseek.js`
owns DOM interaction. The loop yields while waiting for the model, storage,
confirmations, and bridge requests. `src/background.js`
owns serialized storage, conversation ownership between tabs, and the existing
handoff alarm polling. The DeepSeek page must remain open for chat interaction;
a reload offers **Resume task** rather than silently restarting tools.

## Conversation and change history

The panel's **Conversation** timeline shows your tasks, assistant updates, tool
steps, and completion summaries in chronological order. The current-action banner
updates while the harness is sending, waiting, executing, or awaiting approval.
**Expand history** gives the timeline more room. Open a step to inspect its
arguments, command, output, errors, duration, and full saved result. Local-agent
steps show live output when the bridge provides it. Older entries can be loaded
with **Show earlier activity**; scrolling back keeps your reading position.

Each call may include a short explanation in its header without adding prose
before the tool block:

```text
⟦DSH⟧{"tool":"dsh_read","summary":"I am checking the current greeting before editing it.","args":{"path":"app.js"}}⟦/DSH⟧
```

The live protocol asks for these user-facing updates and a final explanation of
changes and checks. Calls without summaries remain compatible. The timeline uses
the existing saved transcript, so reloading restores completed steps without
executing them again. A step whose final result was lost is labeled **Outcome
unknown**. Rejected responses, denied operations, and failures remain visible.

Successful direct writes and edits include bounded before/after diff previews.
The changed-file list links to the corresponding steps; it counts only confirmed
changes and distinguishes workspaces. Large previews are labeled as shortened.
Historical steps created before diff capture was available keep their arguments
and results, but cannot reconstruct an old before/after diff. Shell commands and
local agents show their own output; arbitrary changes inside those processes are
not inferred from their exit status.

Diff capture respects the file read policy, including hiding `.env` contents.
Displayed credentials and confirmation tokens are masked, and content is rendered
as literal text. The saved transcript is preserved. The old diagnostics log
remains available below the timeline.

## Tool arguments and parsing errors

Existing JSON calls remain compatible:

```text
⟦DSH⟧{"tool":"dsh_read","args":{"path":"README.md"}}⟦/DSH⟧
```

Strict JSON is attempted first. If it fails, the parser escapes literal control
characters and quotes that cannot terminate a JSON string value, then parses
again. Already valid JSON is never rewritten. Arbitrarily malformed JSON is
ambiguous; unsuccessful repairs produce an explicit error rather than guessed
arguments or a lost tool call.

The panel and saved transcript retain the exact rejected output. Recovery sends a
bounded excerpt back to the model and allows two retries. A third failure pauses
the task. Partial markers (including `⟦DS`) and bare `text`, `Safe`, or empty
responses count as failures rather than task completion. Repeated write failures
request a smaller chunk with complete framing; they do not trigger a handoff.

Native DSML (`<｜DSML｜...>` and variants), `function_calls`, and `invoke` wrappers
are unsupported tool output. They trigger explicit protocol recovery rather than
task completion, including after a shell or file-tool failure. The harness asks
for a new DSH call using the live tool catalog (`dsh_bash` for commands). It never
automatically converts or executes the native parameter text. Literal native
markup inside validated DSH file arguments remains ordinary file content. Mixed
DSH/native output rejects the entire turn. Older checkpoints that ended on native
markup offer **Resume** after reload; their saved transcript is preserved and no
native command is replayed.

For complex code, the model can avoid JSON escaping altogether:

```text
⟦DSH⟧
{"tool":"dsh_write","args":{"path":"index.html"}}
⟦DSH:ARG:content⟧
<a href="link">Literal HTML, CSS, and JavaScript can go here.</a>
⟦/DSH:ARG:content⟧
⟦/DSH⟧
```

Raw argument markers each occupy their own line. The one newline separating the
payload from each marker is framing; other payload whitespace is preserved.
`planText`, `oldText`, and `newText` also support raw argument blocks. An argument
cannot appear both in the JSON header and in a raw block. The model is instructed
to start with one complete tool block and end the response after it. The parser
still accepts up to three calls for compatibility. If any block fails validation,
none of that response's calls execute.

For long documents, aim below 1.5 KB of content per response. Write the first
chunk with `dsh_write`, verify it with `dsh_read`, then append the next chunk:

```text
⟦DSH⟧{"tool":"dsh_write","args":{"path":"report.md","content":"Next chunk\n","append":true,"expectedSha256":"<hash from preceding write or read>"}}⟦/DSH⟧
```

Append requires an existing file and its current hash. A stale hash rejects a
repeated append before it can duplicate the chunk. Read back each chunk before
continuing. The 1.5 KB recommendation reduces generation/truncation risk; it is
not a bridge limit. Complete multi-KB JSON and raw calls remain supported. The
bridge accepts HTTP bodies up to 10 MB and file contents up to its existing 2 MB
limit; neither proves where an upstream response was cut off.

Both tagged safety reviews (`ds_safety`/`ds-safety`, either case) and the leading
raw Chinese review header are stripped. Literal safety tags inside code arguments
are preserved.

## Persistence and recovery

The **Permissions** selector saves its choice immediately:

- **Full access** runs tools without approval prompts and automatically satisfies
  bridge confirmation requests. Shell commands support chaining, pipes,
  redirection, and the shell's normal syntax in this mode.
- **Ask for important commands** (default) asks before shell commands outside
  the safe list and changes to sensitive files such as `.env`, `package.json`,
  and dependency lockfiles.
- **Ask every time** asks before each tool call, including reads and handoffs.
  Denying a call sends no execution request; approving it requires only one prompt,
  even if the bridge also needs a confirmation token.

Direct file tools retain workspace/path checks. Full access grants an
unrestricted shell; the other modes retain shell command checks. On Windows,
`dsh_bash` uses `cmd.exe`: use `dir`, `type`, and `findstr`. For PowerShell, invoke
`powershell.exe` explicitly. Percent-delimited strings can expand environment
variables even in quoted arguments; take care when constructing encoded URLs.
On other platforms it uses `/bin/sh`. The live tool description and command
results identify the shell. Nonzero command exits return `E_COMMAND_FAILED`,
with `exitCode`, captured `stdout`/`stderr`, and shell under `error.extra`.
An empty diagnostic stream is reported explicitly.

Command timeouts retain captured stdout/stderr, the requested timeout, and process
cleanup status under `error.extra`. Windows process-tree cleanup runs asynchronously
with a three-second cleanup deadline, keeping bridge health requests responsive.
If termination cannot be confirmed, the timeline labels the outcome unknown and
the error asks for inspection before retrying. Recursive searches should start
inside the project and skip dependency directories during traversal; filtering
their printed results afterward does not avoid visiting those directories.

Large successful results include `fullOutputWorkspace` and an exact `readWith`
call. Paths under `.dsh-pro/outputs/` are relative to that workspace, even when a
shell command changed its own directory with `cd`. A plain `textOutputFile`
accompanies large stdout/content results so line-range reads can page through the
report; `fullOutputFile` retains the complete JSON result. Never prepend `../`.
For older command-output JSON, `dsh_read` with `jsonField:"stdout"` reads the
unescaped report using the usual `offset` and `limit`. The returned hash still
identifies the original JSON source file. JSON-field reads use the normal path,
binary, and file-size guards. A failed saved-output read receives a workspace/path
recovery hint; path-escape checks remain enforced.

A handoff approval covers starting
that local agent; its internal actions use the local agent's own configuration.
Stop the active task to change the permission setting.

Executable presence does not establish handoff credential readiness. The local
agent needs separate provider credentials from its credentials service or launch
environment (`DEEPSEEK_API_KEY` for `deepseek-official`). Health reports credentials
as `unverified` until a missing-credential failure is observed. That failure returns
`E_MISSING_CREDENTIAL` with configuration guidance, removes handoff from the live
catalog, and blocks further handoffs for that bridge process. Direct tools remain
available. After configuring credentials, restart the bridge and reconnect. The
bridge does not inspect secret stores or treat an absent environment variable as
proof that service-managed credentials are missing.

Bridge read requests retry transient network failures twice, with a five-second
timeout per attempt. Tool submissions are never automatically retried after a
network failure because they may already have executed. Failures identify the
endpoint, mark the bridge disconnected, and retain the checkpoint. Resume always
rechecks bridge health and tool definitions. A handoff status outage preserves
the remote run ID so Resume can reattach without launching another handoff.

Outgoing history uses a bounded view that removes duplicate raw responses,
replaces archived code arguments with metadata, excerpts large outputs, and
prioritizes the latest user task and unresolved execution intents. Every original
entry remains in local storage, including its exact code and results. The live
tool catalog is sent with continuations so old protocol text cannot advertise
removed tools. Reset resets the persisted iteration/retry counters and preserves
the transcript; Resume continues with the retained results.

The bridge starter compares a hash of installed JavaScript/configuration to the running build
and refreshes an older idle bridge. It refuses to interrupt active work and reads
legacy handoff state before upgrading an older process. Health and connection
logs report the loaded build and tool count. npm `dsh.cmd`/PowerShell shims resolve
to the package's JavaScript entry point before Node is launched.

Each `chrome.storage.local` key named
`dshpro:conversation:<origin><pathname>` contains:

- `conversationHistory`: user, assistant (including raw blocks), system, and tool entries.
- `iterationCount`, `retryCount`, and `writeFailures`.
- `inProgress`, `stage`, `workspace`, and any outstanding `handoffRunId`.
- A storage revision to reject stale writes from another tab.

Session storage keeps short-lived ownership leases and handoff alarm state. The
same tab can reclaim its checkpoint after a reload; competing active tabs are
rejected. When a blank DeepSeek chat gets its permanent URL, its checkpoint and
lease move to that URL.

Execution intent is saved before a bridge call. Resume does not replay recorded
tools. It supplies the model with previous results and instructs it to inspect
the workspace when an intent has no recorded result. An outstanding handoff is
polled to completion and its result is appended instead of starting another one.
The bridge API has no request idempotency key, so this intentionally does not
claim exactly-once execution after a browser crash during an HTTP request.

The Stop button cancels previews, response waits, confirmation dialogs, and
handoff polling, requests cancellation of the local handoff, and clicks the web
chat's Stop control when present. Results from an already accepted ordinary tool
are recorded before the loop exits.

## DOM and sending

Selectors prefer semantic roles, test IDs, and accessible English/Chinese labels.
The observed DeepSeek layout also uses an unlabeled circular `div[role="button"]`
with an arrow SVG and a `ds-button--disabled` CSS class. These controls are
recognized directly. Attachment-only messages are sent by the native page and
their response is observed once, rather than being ignored because the composer
has no text.
The send candidates include `button[type="submit"]`, `button[class*="send"]`,
and clickable elements with `role="button"`. If none is found after 500ms, Enter
is dispatched once. Submission must then be acknowledged by the composer clearing,
streaming starting, or the assistant changing. Otherwise the loop pauses visibly.
Unrelated user drafts are never overwritten by an automatic continuation.

Response completion uses a MutationObserver and fresh completion evidence on the
current assistant message. A disappearing Stop control alone cannot complete a
response. On DeepSeek's virtualized list, completion
actions are siblings of `.ds-message`, outside the markdown element. They are
checked only within that response's own `[data-virtual-list-item-key]` container,
so an older response's footer cannot complete a new turn. A response watchdog reports a stalled UI;
it never treats elapsed time alone as proof that a response is complete. DeepSeek
can change its private DOM, so real-site selector compatibility still needs a
logged-in smoke check. Diagnostics and Settings expose selector overrides.

During an active response, a visible Continue / Continue generating / 继续生成
button in the current assistant message is clicked automatically, including
successive continuations. Disabled controls wait until enabled. Older messages
and buttons embedded in Markdown/code are ignored. The paused segment is never
parsed or executed, even if it already has completion actions. Capture still
requires fresh completion evidence after continuation. Each click renews the
response watchdog; an unresponsive Continue button still times out, and Stop
cancels the wait. Custom
selectors can override `continueButton`, and captures record `continuationCount`.

Capture reads the whole assistant message rather than a single Markdown fragment,
including sibling code blocks. After message completion evidence appears, text
must settle before capture. Incomplete framing and placeholder output receive a
two-second rendering grace period, reset by text changes. A genuinely incomplete
response is then rejected normally; the harness never invents closing markers or
arguments. Recovery asks for a shorter call without the optional summary field.

Each capture records its timestamp, message key, source container, character count,
and settle duration. **Last rejected response** retains this information alongside
the rejected text, even if a later response succeeds. **Diagnostics** reports both
the last saved capture and the current assistant DOM, so old diagnostics or an
early capture can be distinguished from a truncated generation.

## Verification

```powershell
npm test
npm run typecheck
npx playwright install chromium
npm run test:e2e
```

Run commands from the repository root after `npm ci`. Node regressions import the
production modules directly. Playwright checks load the WXT production extension
with its real MV3 service worker, messaging, storage, and alarms, alongside chat
fixtures and a local HTTP fixture bridge. They cover streaming, permissions,
cancellation, recovery, competing tabs, service-worker restarts, and the panel.
They do not contact DeepSeek or execute tools on the user's workspace.

See [the development guide](../DEVELOPMENT.md) for architecture, commands, and
moving an existing installation to the WXT build.
