# Tool text integrity investigation, October 25, 2026

The supplied execution log covers roughly five minutes spent inspecting a Java
project and writing its README. The main actionable problem is the cycle of
writes, readbacks, and shell workarounds for damaged text. The log omits write
contents and command output, so it cannot establish exactly which characters
were lost in each write or why each command failed.

## Findings and changes

- The adapter previously extracted rendered heading, list, emphasis, inline-code,
  link, and math text without detecting lost source syntax. A tool call could
  remain parseable while its Markdown punctuation or dollar variables changed.
  The adapter now records the affected character ranges. The protocol rejects
  any response with those ranges inside a tool call before executing its calls,
  and asks the model to regenerate literal fenced text. Formatted narration
  outside tool calls remains supported. Code inside PRE elements stays literal.
- Commands in the log contain actual control characters where Windows path
  separators were intended: a tab before `mp`, a form feed before `ix-readme`,
  and a carriage return before `esources`. These are consistent with JSON
  interpreting `\t`, `\f`, and `\r`. Instructions now recommend forward slashes
  for JSON paths, doubled JSON backslashes, and raw command arguments. File tools
  reject control characters in paths with a specific escaping diagnostic.
  Failed Windows shell commands containing control characters also include a
  targeted escaping hint, alongside their original exit status and output.
  Commands are not automatically rewritten because their intended bytes are
  ambiguous; raw arguments preserve intentional whitespace and backslashes.
- The harness previously instructed the model to read every chunk before
  appending. Successful writes already return the new hash. Instructions now
  use that hash for subsequent appends and request a final readback; uncertain
  writes still require inspection before retrying.
- Instructions now require the entire tool call in one text fence and explain
  how to choose a longer fence when writing Markdown containing code fences.
  File tools are preferred for file content, avoiding fragile shell `echo`
  workarounds for characters that the bridge already writes correctly.

## False completion on tool markup

The additional harness log reveals a separate false-completion bug:
`<DSH_TOOL>` was not recognized as `<ds_tool>` or the canonical DSH markers.
The model's last call also omitted the outer JSON closing brace. The harness
therefore treated the whole response as completion prose instead of requesting
a corrected call, regardless of its remaining iteration budget. Case-insensitive
`DSH_TOOL`/`DSH-TOOL` aliases now receive ordinary tool validation; malformed,
partial, orphaned, and mismatched wrappers trigger recovery. The adapter also
preserves these wrappers when the browser renders them as custom elements.
Saved tasks falsely completed on tool markup now offer Resume, label the old
proposal unexecuted, and tell the model to regenerate it. Resume does not execute
the saved proposal automatically.

## Limits of the earlier analysis

- Four logged PowerShell command durations total about 7.38 seconds. Those
  durations include command execution; the log does not isolate startup cost.
  Replacing them with shell-generated file content would not address text loss.
- The first failed resource listing contains a carriage return in its path.
  The log does not establish that the intended directory was absent.
- The decimal exit code 4294770688 is hexadecimal `0xFFFD0000`. Without stderr
  and the original script, it does not establish a syntax error or script crash.
- Several read calls share timestamps only milliseconds apart, showing they
  were grouped closely. The log cannot support a claim that all calls waited
  for separate model turns. The harness deliberately executes tool calls in
  order, preserving dependent writes and approval behavior.
- File reads typically took 0–2 ms. The much larger gaps between calls include
  model generation, browser interaction, and configured pacing. Tool timings
  alone do not explain the full five-minute elapsed time.

## Verification

Regression coverage exercises literal Markdown and script writes, raw Windows
commands, control-character path errors, rejection of an entire response when
one call contains rendered text, and recovery without replaying rejected calls.
Browser fixtures exercise rendered headings/lists/emphasis and math, followed
by exact literal content captured from code blocks. These checks reproduce the
failure mechanisms; live DeepSeek rendering still requires a manual check after
reloading the extension.
