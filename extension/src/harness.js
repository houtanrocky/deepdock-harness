import { protocol } from './core/protocol.js';
import { history } from './core/history.js';
import { initCommand, initMessage, projectInstructionsMessage } from './core/project-context.js';
import { selectors } from './adapters/selectors.js';
import { createDeepSeekAdapter } from './adapters/deepseek.js';
import { DEFAULT_LOOP_LIMIT, DEFAULT_TOOL_RESULT_DELAY_SECONDS, MAX_TOOL_RESULT_DELAY_SECONDS, PERMISSION_MODES, normalizeBridgeUrl, normalizeToolResultDelaySeconds } from './contracts.ts';
import { mountPanel, renderPanelState, showAgentView, showPanelView } from './ui/panel.ts';
import { renderActivity } from './ui/activity.js';

// DeepDock Harness: one cancellable async loop per task. Status labels describe the UI;
// they do not drive execution. Durable checkpoints are owned by background.js.
export function createHarness({ browser, platform = globalThis, ports = {}, scheduleInterval = platform.setInterval }) {
  const { document, location, crypto, AbortController, KeyboardEvent,
    setTimeout, clearTimeout, clearInterval } = platform;
  let navigationTimer;
  let disposed = false;
  const state = {
    connected: false, enabled: false, status: 'Disabled', health: null, tools: null, bridgeError: '',
    loopLimit: DEFAULT_LOOP_LIMIT, loopsLeft: DEFAULT_LOOP_LIMIT, toolResultDelaySeconds: DEFAULT_TOOL_RESULT_DELAY_SECONDS, dailyLimit: 200, workspace: '', token: '',
    customSelectors: null, run: null, activeRunId: null, automaticSend: false,
    lastSendAt: 0, pendingTask: false, conversationHistory: [], checkpoint: null,
    permissionMode: 'important',
  };
  const MAX_CALLS = 3;
  const MAX_RETRIES = 2;
  const MAX_PROMPT_CHARS = 200000;
  function permissionMode(value) { return Object.hasOwn(PERMISSION_MODES, value) ? value : 'important'; }

  function conversationUrl() { return location.origin + location.pathname; }
  function fail(message, code = 'E_AGENT') { return Object.assign(new Error(message), { code }); }
  function aborted() { return fail('Task stopped.', 'E_STOPPED'); }
  function checkRun(run) {
    if (disposed || run.controller.signal.aborted) throw aborted();
    if (conversationUrl() !== run.url && !(run.allowNewConversation && /^\/(?:a\/)?chat\//.test(location.pathname))) throw fail('Conversation changed. Resume the task in its original chat.', 'E_NAVIGATION');
  }
  async function adoptConversation(run) {
    if (conversationUrl() === run.url) return;
    checkRun(run);
    const destination = conversationUrl();
    const saved = await message({ type: 'conversationMove', url: run.url, destination, runId: run.id, data: run.data });
    run.url = destination; run.data.revision = saved.revision; run.allowNewConversation = false;
  }
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(aborted());
      const cleanup = () => signal?.removeEventListener('abort', cancel);
      const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
      function cancel() { clearTimeout(timer); cleanup(); reject(aborted()); }
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }
  function log(message) {
    if (disposed) return;
    const box = document.getElementById('dshpro-log');
    if (box) box.textContent = (`[${new Date().toLocaleTimeString()}] ${message}\n` + box.textContent).split('\n').slice(0, 100).join('\n');
  }
  function setStatus(status) {
    if (disposed) return;
    state.status = status;
    const label = document.getElementById('dshpro-phase');
    if (label) label.textContent = status;
    const dot = document.getElementById('dshpro-dot');
    if (dot) dot.className = 'dshpro-dot' + (!state.connected || status.startsWith('Paused') ? ' err' : state.run ? ' busy' : ' ok');
    const workspace = document.getElementById('dshpro-workspace');
    if (workspace) workspace.disabled = Boolean(state.run);
    const permissions = document.getElementById('dshpro-permissions');
    if (permissions) permissions.disabled = Boolean(state.run);
    refreshLoops();
    renderPanelState(document, state);
    renderActivity(document, state);
  }
  async function message(body) {
    let result;
    try { result = await browser.runtime.sendMessage(body); }
    catch (error) { throw fail('Extension connection failed: ' + error.message); }
    if (!result || result.ok === false) throw fail(result?.error || 'No response from extension background service.');
    return result;
  }
  async function bridgeRequest(request) {
    let response;
    try { response = await browser.runtime.sendMessage(request); }
    catch (error) { response = { ok: false, status: 0, error: 'Extension connection failed: ' + error.message + '. Reload the extension and refresh DeepSeek.' }; }
    if (!response || response.status === 0 || (response.ok === false && !response.status)) {
      response = { ...response, ok: false, status: 0, error: response?.error || 'No response from extension background service. Reload the extension and refresh DeepSeek.' };
      state.connected = false;
      state.bridgeError = response.error;
    }
    return response;
  }
  function bridge(method, path, body) { return ports.bridge ? ports.bridge(method, path, body) : bridgeRequest({ type: 'bridge', method, path, body }); }

  const adapter = createDeepSeekAdapter({ platform, getCustomSelectors: () => state.customSelectors, selectors, checkRun, fail, aborted });
  const { selList, findInput, findLastAssistant, composerScope, findStopButton, findSendButton,
    stopButtonVisible, enabledButton, inputText, assistantSnapshot, waitForAssistant, waitForDOM, setNativeValue } = adapter;

  async function previewSend(text, run) {
    const box = document.getElementById('dshpro-preview');
    if (!box) throw fail('The send preview is unavailable. Refresh this tab.');
    box.style.display = 'block';
    box.textContent = 'Sending in 2s (click to cancel):\n' + text.slice(-1500);
    box.onclick = () => run.controller.abort();
    try { await sleep(2000, run.controller.signal); }
    finally { box.style.display = 'none'; box.onclick = null; }
  }
  async function dailyCount() {
    const { daily } = await browser.storage.local.get({ daily: { date: '', count: 0 } });
    const date = new Date().toISOString().slice(0, 10);
    return daily.date === date ? daily : { date, count: 0 };
  }
  function sendText(...args) { return (ports.send || sendChatText)(...args); }
  async function sendChatText(text, run, expectedDraft = '') {
    checkRun(run);
    if (text.length > MAX_PROMPT_CHARS) throw fail('The outgoing message exceeds the send limit after compaction. Shorten the latest task or attach its large source files. The saved history has been preserved.');
    const daily = await dailyCount();
    if (daily.count >= state.dailyLimit) throw fail(`Daily automatic send limit reached (${daily.count}/${state.dailyLimit}).`);
    setStatus('Sending to DeepSeek...');
    await previewSend(text, run);
    await sleep(Math.max(0, 1500 - (Date.now() - state.lastSendAt)), run.controller.signal);
    checkRun(run);
    const input = findInput();
    if (!input) throw fail('Input field not found. Open Diagnostics or configure custom selectors.');
    if (inputText(input).trim() && inputText(input) !== expectedDraft) throw fail('The composer contains an unsent draft. It was preserved; send or clear it before resuming.');
    if (stopButtonVisible()) throw fail('DeepSeek is still generating. Stop it before starting or resuming an agent task.');
    const baseline = assistantSnapshot();
    const waiter = waitForAssistant(run, baseline);
    try {
      setNativeValue(input, text);
      // Wait for the reactive composer to render an enabled button. Enter is a
      // documented fallback after 500ms, never evidence that a send succeeded.
      await sleep(500, run.controller.signal);
      checkRun(run);
      const button = findSendButton();
      if (button && !enabledButton(button)) throw fail('Send button is disabled. Check the composer and try again.');
      state.automaticSend = true;
      try {
        if (button) button.click();
        else {
          log('Send button not found after 500ms; trying Enter once and verifying submission.');
          input.focus();
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
        }
      } finally { state.automaticSend = false; }
      await waitForDOM(() => !inputText(input).trim() || stopButtonVisible() || assistantSnapshot().raw !== baseline.raw,
        run.controller.signal, 5000, 'DeepSeek did not accept the message. Text remains in the composer; fix Send selectors in Settings.');
      state.lastSendAt = Date.now();
      await browser.storage.local.set({ daily: { date: daily.date, count: daily.count + 1 } });
      return waiter;
    } catch (error) { waiter.cancel(); throw error; }
  }

  async function loadConversation(url = conversationUrl()) {
    const data = (await message({ type: 'conversationLoad', url })).data;
    const lastAssistant = [...data.conversationHistory].reverse().find((entry) => entry.role === 'assistant');
    // Older versions could treat tool markup as a final answer. Offer
    // explicit Resume for those checkpoints; never replay or execute the markup.
    if (data.stage === 'completed' && lastAssistant) {
      const parsed = protocol.parse(lastAssistant.raw || lastAssistant.content);
      if (parsed.errors.length || parsed.calls.length) return { ...data, stage: 'error', inProgress: true, conversationHistory: [...data.conversationHistory, {
        role: 'system', kind: 'parse-error', content: 'A previous version marked an unexecuted tool response as complete. No calls from that final response executed. Regenerate the remaining action in one complete fenced DSH block; do not assume it ran or replay earlier successful tools.',
      }] };
    }
    return data;
  }
  async function saveRun(run, allowStopped = false) {
    if (!allowStopped) checkRun(run);
    const saved = await message({ type: 'conversationSave', url: run.url, runId: run.id, data: run.data });
    run.data.revision = saved.revision;
    state.checkpoint = run.data;
    state.conversationHistory = run.data.conversationHistory;
    renderActivity(document, state);
  }
  async function appendHistory(run, role, content, extra = {}) {
    const entry = { id: crypto.randomUUID(), role, content, timestamp: new Date().toISOString(), runId: run.id, workspace: run.data.workspace || state.workspace, ...extra };
    run.data.conversationHistory.push(entry);
    if (role === 'tool') run.data.pendingToolResults = true;
    await saveRun(run, role === 'tool');
    return entry;
  }
  function availableTools() {
    return (state.tools?.tools || []).filter((tool) => tool.name !== 'dsh_handoff' || (state.health?.dsh?.binFound && state.health.dsh.available !== false));
  }
  function buildProtocolMessage(handshake = true) {
    const definitions = availableTools();
    const names = new Set(definitions.map((tool) => tool.name));
    const handoffReady = names.has('dsh_handoff') && state.health?.dsh?.binFound;
    return [
      '[DeepDock Harness enabled] You have a local tool bridge. Communicate in English.',
      ...definitions.map((tool) => `- ${tool.name}: ${tool.description}. Parameters: ${JSON.stringify(tool.params)}`),
      'Use workspace-relative paths for file tools. The extension handles approval prompts according to the user-selected permission setting.',
      `Permissions: ${PERMISSION_MODES[permissionMode(state.permissionMode)].label}. ` + (state.permissionMode === 'full' ? 'Shell commands may use normal shell syntax, including pipes, command chains, and redirection.' : 'Shell commands use the bridge command checks. Use the dedicated Git/GitHub tools for publishing.'),
      `Current default workspace: ${state.workspace || '(first authorized root)'}. To choose another authorized root, set args.workspace to that absolute root and keep args.path relative to it.`,
      'The user command /init asks you to inspect the project and create or carefully update its AGENTS.md using the regular file tools. Follow the initialization instructions supplied with that task.',
      state.health?.capabilities?.projectInstructions ?
        'Applicable AGENTS.md files are loaded automatically. Follow the current project instructions and their directory scopes. Before shell commands or handoffs in a subdirectory, use dsh_instructions with that directory.' :
        'This bridge does not support automatic project instructions. Before coding, read any root and applicable nested AGENTS.md files using the file tools. Updating the bridge enables automatic loading.',
      `For actions, start with exactly ONE complete tool block and end the response after it: ${protocol.OPEN}{"tool":"tool_name","args":{}}${protocol.CLOSE}`,
      `Never emit more than ${MAX_CALLS} tool calls in one response. Exceeding this limit rejects the entire response; none of its calls execute.`,
      'Each tool call needs its own complete opening and closing markers. A completed JSON object still needs its closing DSH marker.',
      'Include a short user-facing explanation in the tool header summary field, for example {"tool":"dsh_read","summary":"I am checking the existing settings before changing them.","args":{"path":"settings.json"}}. Explain the immediate purpose and, when useful, what the preceding result established. The user sees these summaries in the activity history. Keep summaries factual and concise; do not include private reasoning. When finished, explain the changes made and checks performed in your final response.',
      'For long files, send content in small chunks (aim below 1.5 KB per chunk). Use dsh_write for the first chunk, then dsh_write with append:true and expectedSha256 from the preceding successful write/read. A successful write returns the new file hash; use it for the next append without rereading every chunk. Read back the completed file to verify it. This is output-truncation guidance, not a bridge byte limit. Never repeat an uncertain write without inspecting the current file.',
      'Only the tools in this live catalog are available. JSON strings must escape quotes and newlines.',
      'Use only DSH tool blocks. Native DSML/function_calls/invoke markup is unsupported and will be rejected. The shell tool is named dsh_bash, not bash. After any tool error, continue using the same DSH format.',
      'Saved-output paths are relative to the workspace named in the result, even when a shell command used cd. Follow the returned readWith call exactly. Never prepend ../ to a returned .dsh-pro/outputs path.',
      'For older saved command-output JSON without readWith, use dsh_read with jsonField:"stdout" and line offset/limit to read the unescaped report. Keep its .dsh-pro/outputs path relative to the original bridge workspace.',
      'Keep recursive searches scoped to the project directory. Filtering output after dir /s or Get-ChildItem -Recurse does not prune traversal of node_modules. Prefer file tools or a traversal that skips dependency directories. After E_TIMEOUT inspect the partial output and narrow the search; do not repeat the same broad command.',
      'For literal code you may also use raw arguments. Do not put the same argument in both JSON and a raw block:',
      '```text', protocol.OPEN, '{"tool":"dsh_write","args":{"path":"index.html"}}',
      '⟦DSH:ARG:content⟧', '<a href="link">Literal code; no JSON escaping needed.</a>', '⟦/DSH:ARG:content⟧', protocol.CLOSE, '```',
      'Raw argument markers must each occupy their own line. Other string arguments (including planText, oldText, and newText) use the same format.',
      'Always put the ENTIRE tool block inside one fenced text code block. Use a fence longer than any backtick run in the payload (for example four backticks around Markdown containing triple backticks). Unfenced Markdown headings, lists, emphasis, links, and math can lose #, -, *, backslashes, or $ expressions before the extension reads them. Preserve every character and all indentation inside the code block. GitHub Actions ${{ ... }} expressions are ordinary literal text and do not conflict with DSH markers.',
      'Use dsh_write or dsh_edit for file content, including Markdown and scripts; do not fall back to shell echo or character-code workarounds for punctuation. For paths in JSON use forward slashes where supported, or double every backslash. In JSON, \\t, \\r, \\n, \\b, and \\f are control-character escapes, not Windows path separators. Prefer a raw command argument inside the outer fence for Windows commands, backslashes, and PowerShell $variables. Raw arguments need no JSON escaping. Inspect error stdout/stderr before retrying a failed command.',
      ...(handoffReady ? ['A local agent executable is present; its separate provider credentials may be unverified. For handoff put a self-contained plan with acceptance criteria in dsh_handoff.planText and end the response. If it reports E_MISSING_CREDENTIAL, continue with direct tools.'] : ['Handoff is unavailable in this connection. Use the available direct tools.']),
      ...(names.has('dsh_github_status') && names.has('dsh_github_create') && names.has('dsh_git_push') ? ['For GitHub publishing, check dsh_github_status and use the dedicated Git/GitHub tools with an explicit project path and user-supplied repository destination. Approvals are handled by the extension permission setting. After dsh_github_create, use dsh_git_push to publish commits.'] : []),
      'When complete, reply with a summary and no tool calls; preferably add a separate line DSH:DONE:your summary.',
      `Hard iteration limit: ${state.loopLimit}. Authorized workspaces: ${(state.health?.allowedRoots || []).join(' ; ')}.`,
      ...(handshake ? ['First reply "Protocol understood", then wait for the user task.'] : []),
    ].join('\n');
  }
  function buildHistoryMessage(run) {
    const lastAssistant = [...run.data.conversationHistory].reverse().find((entry) => entry.role === 'assistant');
    const repairGuidance = lastAssistant?.repaired && !lastAssistant.parseErrors?.length ?
      '\n[DeepDock Harness System] Your previous tool JSON required automatic repair. Its validated calls were processed; consult their recorded results before continuing. For subsequent code or multiline string arguments, use raw argument blocks inside a fenced text code block instead of embedding code in JSON strings. Keep the JSON header strictly valid. Do not repeat successful actions.\n' : '';
    if (!run.historyCompactionLogged && JSON.stringify(run.data.conversationHistory).length > MAX_PROMPT_CHARS) {
      run.historyCompactionLogged = true;
      log('Sending a compact history view. The complete saved transcript has been preserved.');
    }
    const context = state.health?.capabilities?.projectInstructions ? projectInstructionsMessage([...(run.projectInstructions?.values() || [])]) : '';
    if (context.length > 60000) throw fail('Project instructions exceed the prompt budget. Shorten the applicable AGENTS.md files before resuming.');
    const prefix = buildProtocolMessage(false) + repairGuidance + context + initMessage(run.initCommand);
    const view = history.build(run.data.conversationHistory, Math.min(150000, MAX_PROMPT_CHARS - prefix.length - 5000));
    return prefix + '\n\n[DeepDock Harness conversation]\nContinue the latest user task using this accumulated transcript. Successful tool results are already executed; do not repeat them. ' +
      'Reply in English. Use DSH tool markers for actions; if finished, give a summary with no tool calls.\n' +
      JSON.stringify(view) +
      `\nIterations remaining: ${state.loopLimit - run.data.iterationCount}. Workspace: ${run.data.workspace || '(default)'}.`;
  }

  async function refreshProjectInstructions(run, calls = []) {
    if (!state.health?.capabilities?.projectInstructions) return false;
    run.projectInstructions ||= new Map();
    const groups = new Map();
    function target(workspace, path) {
      const selected = workspace || run.data.workspace || state.health.allowedRoots?.[0] || '';
      if (!groups.has(selected)) groups.set(selected, new Set(['.']));
      groups.get(selected).add(path);
    }
    target(run.data.workspace, run.initCommand?.target || '.');
    for (const entry of run.projectInstructions.values()) target(entry.workspace, entry.path);
    for (const call of calls) {
      const args = call.args;
      target(args.workspace, typeof args.path === 'string' ? args.path : '.');
      if (call.tool === 'dsh_instructions' && Array.isArray(args.paths)) for (const path of args.paths) target(args.workspace, path);
      if (call.tool === 'dsh_git_add' && Array.isArray(args.files)) {
        for (const file of args.files) target(args.workspace, (args.path || '.') + '/' + file);
      }
    }
    const before = JSON.stringify([...run.projectInstructions]);
    const requests = [];
    for (const [workspace, paths] of groups) {
      const targets = [...paths];
      for (let offset = 0; offset < targets.length; offset += 64) requests.push({ workspace, paths: targets.slice(offset, offset + 64) });
    }
    for (const args of requests) {
      checkRun(run);
      if (permissionMode(state.permissionMode) === 'always') {
        const allowed = await showConfirm('Load project instructions', args, 'Read applicable AGENTS.md files before continuing this task.', run.controller.signal);
        checkRun(run);
        if (!allowed) throw fail('Project instruction loading was denied. Task paused before sending more code or executing tools.', 'E_USER_DENIED');
      }
      const response = await bridge('POST', '/instructions', args);
      checkRun(run);
      if (!response?.json?.ok) throw fail('Could not load project instructions: ' + (response?.json?.error?.message || response?.error || 'Update or reconnect the local bridge.'));
      const data = response.json.data;
      if (!data || typeof data.workspace !== 'string' || !Array.isArray(data.checkedFiles) || !Array.isArray(data.instructions) ||
          data.instructions.some((entry) => typeof entry.path !== 'string' || typeof entry.scope !== 'string' || typeof entry.content !== 'string' || typeof entry.sha256 !== 'string')) {
        throw fail('The bridge returned invalid project instructions. Update or reconnect the local bridge.');
      }
      for (const path of data.checkedFiles) run.projectInstructions.delete(JSON.stringify([data.workspace, path]));
      for (const entry of data.instructions) run.projectInstructions.set(JSON.stringify([data.workspace, entry.path]), { workspace: data.workspace, ...entry });
    }
    // Order is stable even when rechecking a previously visited directory.
    run.projectInstructions = new Map([...run.projectInstructions].sort(([a], [b]) => a.localeCompare(b)));
    return before !== JSON.stringify([...run.projectInstructions]);
  }
  function showParserError(errors, completion) {
    showAgentView(document);
    const box = document.getElementById('dshpro-parser-error');
    if (box) {
      const capture = completion ? `Captured ${completion.capturedAt || '(time unavailable)'}; iteration ${state.run?.data?.iterationCount}; message ${completion.messageKey || '(no key)'}; ${completion.chars} characters from ${completion.source || '(unknown source)'}; stable for ${completion.domStableMs || 0}ms.\n\n` : '';
      box.hidden = false;
      box.querySelector('pre').textContent = capture + errors.map((error) => `${error.message}\n\n${error.raw || ''}`).join('\n\n');
    }
    for (const error of errors) log('Tool-call parse error: ' + error.message);
  }
  function recoveryMessage(parsed, run, completion) {
    const details = parsed.errors.map((error) => error.message).join('; ');
    if (parsed.errors.some((error) => error.message.startsWith('Unknown tool:'))) return `[DeepDock Harness System] A requested tool is unavailable in the connected bridge. Error: ${details}. Available tools: ${availableTools().map((tool) => tool.name).join(', ')}. Use the live tool catalog in this message; do not retry the unavailable tool or repeat successful actions.`;
    if (parsed.errors.some((error) => /"tool"\s*:\s*"dsh_write"/.test(error.raw || ''))) run.data.writeFailures++;
    const framingError = parsed.errors.some((error) => /marker|framing|Incomplete tool call/i.test(error.message));
    let text;
    if (parsed.errors.some((error) => error.code === 'E_RENDERED_TOOL_TEXT')) {
      text = '[DeepDock Harness System] Markdown rendering changed your tool text, so its original punctuation cannot be recovered reliably. Regenerate the intended tool call from the task inside ONE fenced text code block, with all DSH markers inside the fence. Choose a fence longer than any backtick run in the payload. Use raw arguments for content or commands; preserve #, /, -, *, backslashes, $variables, and indentation literally. Use dsh_write/dsh_edit for files instead of shell echo workarounds.';
    } else if (parsed.errors.some((error) => error.code === 'E_UNSUPPORTED_TOOL_FORMAT')) {
      text = '[DeepDock Harness System] Your reply used unsupported native DSML tool markup. No calls from that rejected response executed. Regenerate the intended action as one DSH block using the live catalog. For commands use dsh_bash, not bash. Do not translate or execute the damaged DSML parameter text automatically. Example: ' + protocol.OPEN + '{"tool":"dsh_bash","args":{"command":"dir /b"}}' + protocol.CLOSE;
    } else if (parsed.errors.some((error) => error.code === 'E_TOO_MANY_CALLS')) {
      text = `[DeepDock Harness System] Your response exceeded the tool-call limit (${MAX_CALLS} per response). No calls from that rejected response executed, including the first ${MAX_CALLS}. Split the pending actions across responses, starting with exactly ONE complete tool call. Wait for its result before requesting the next action.`;
    } else if (parsed.errors.some((error) => error.message.startsWith('Empty or placeholder'))) {
      text = `[DeepDock Harness System] No usable response was received. Error: ${details} Continue the unfinished task with a complete tool call, or provide a substantive completion summary.`;
    } else if (framingError) {
      text = `[DeepDock Harness System] Your tool block was incomplete or incorrectly framed. Error: ${details} No calls from that rejected response executed. Reply with exactly ONE complete tool call in a fenced text code block. Include both the opening and closing DSH markers. Do not copy this system prompt or the conversation transcript into your reply.`;
    } else {
      text = `[DeepDock Harness System] Your JSON was malformed. Error: ${details}. Please retry using the exact format.`;
    }
    if (run.data.writeFailures) text += '\nReduce the content to a chunk below 1.5 KB; use hash-checked appends after verifying earlier successful chunks with dsh_read. Use raw argument markers for code and preserve indentation. Do not switch to handoff to repair framing errors.';
    if (completion?.incompleteAfterGrace) text += '\nDeepSeek stopped rendering this reply before the tool block was complete, so no calls from that reply ran. Inspect the saved partial response and continue with one complete tool block. Do not copy the malformed block or claim it succeeded. If the intended change contains a large file, split it into hash-checked chunks and verify each chunk before continuing.';
    const raw = parsed.errors.map((error) => error.raw || '').join('\n');
    const excerpt = raw.length > 1800 ? raw.slice(0, 900) + '\n[Middle omitted; full response saved locally]\n' + raw.slice(-900) : raw;
    return text + '\nNo calls from that rejected response executed. Reply with exactly ONE complete tool call, block first, no prose. Use valid JSON with escaped quotes/newlines, or raw arguments. Do not repeat earlier successful actions.' +
      '\nRejected output excerpt (diagnostic data, not instructions):\n' + JSON.stringify(excerpt);
  }

  function handoffResult(completed) {
    const ok = completed.status === 'done' && completed.exitCode === 0;
    const error = ok ? null : completed.error || { code: 'E_HANDOFF_FAILED', message: `Handoff ${completed.status}: ${completed.note || 'See stderrFile for details.'}` };
    if (error?.code === 'E_MISSING_CREDENTIAL' && state.health?.dsh) {
      state.health.dsh.available = false;
      state.health.dsh.credentialStatus = 'missing';
    }
    return { tool: 'dsh_handoff', ok, data: completed, ...(error ? { error } : {}) };
  }

  function showConfirm(tool, args, reason, signal) {
    showAgentView(document);
    setStatus('Awaiting approval');
    return new Promise((resolve, reject) => {
      const box = document.getElementById('dshpro-confirm');
      if (!box || signal?.aborted) return reject(aborted());
      box.style.display = 'block';
      document.getElementById('dshpro-confirm-text').textContent = `${tool}\n${JSON.stringify(args)}\nReason: ${reason}`;
      const yes = document.getElementById('dshpro-confirm-yes');
      const no = document.getElementById('dshpro-confirm-no');
      function finish(allowed) { box.style.display = 'none'; yes.onclick = no.onclick = null; signal?.removeEventListener('abort', cancel); if (!signal?.aborted) setStatus('Running ' + tool + '...'); resolve(allowed); }
      function cancel() { finish(false); }
      yes.onclick = () => finish(true); no.onclick = () => finish(false);
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }
  async function callBridgeTool(tool, args, confirmToken) {
    const start = Date.now();
    let response;
    try { response = await bridge('POST', '/tool', { tool, args, workspace: args.workspace || state.run?.data?.workspace || state.workspace || undefined, ...(confirmToken ? { confirmToken } : {}) }); }
    catch (error) { response = { status: 0, error: error.message }; }
    if (!response || response.status === 0) return { tool, ok: false, error: { code: 'E_BRIDGE_UNREACHABLE', message: response?.error || 'Bridge service unreachable. Check start-deepdock.cmd.' } };
    const json = response.json || {};
    return { tool, ok: Boolean(json.ok), durationMs: Date.now() - start, ...(json.ok ? { data: json.data } : { error: json.error || { code: 'E_INTERNAL', message: 'Unknown bridge error' } }) };
  }
  async function cancelHandoff(runId) {
    const response = await bridge('POST', `/handoff/${runId}/cancel`);
    if (!response?.json?.ok) throw fail(`Could not confirm cancellation of handoff ${runId}. Check the local bridge before resuming.`);
  }

  // Keep the existing handoff endpoint and background alarm tracking. A stopped
  // tab cancels the actual local process, rather than just abandoning its poll.
  async function pollHandoff(runId, timeoutMs, run = state.run) {
    state.activeRunId = runId;
    run.handoffRunId = runId;
    const deadline = Date.now() + (timeoutMs || 300000) + 5000;
    let lastProgress = 0;
    try {
      await message({ type: 'trackHandoff', runId });
      while (true) {
        checkRun(run);
        const response = await bridgeRequest({ type: 'handoffStatus', runId });
        if (!response?.ok) throw fail(response?.json?.error?.message || response?.error || 'Handoff status is unavailable. Reconnect to the local bridge and resume.');
        const result = response?.json?.run;
        if (result && result.status !== 'running') return result;
        state.handoffProgress = { elapsedMs: result?.elapsedMs, liveTail: result?.liveTail || '' };
        renderActivity(document, state);
        if (Date.now() > deadline) throw fail('Handoff polling timed out. Check the local bridge before resuming.', 'E_HANDOFF_TIMEOUT');
        if (Date.now() - lastProgress > 20000) {
          lastProgress = Date.now();
          log(`Handoff ${runId} running (${Math.floor((result?.elapsedMs || 0) / 1000)}s). ${result?.liveTail?.slice(-120) || ''}`);
        }
        await sleep(5000, run.controller.signal);
      }
    } catch (error) {
      if (error.code === 'E_STOPPED' || error.code === 'E_HANDOFF_TIMEOUT') await cancelHandoff(runId).catch((cancelError) => log(cancelError.message));
      throw error;
    } finally { state.activeRunId = null; run.handoffRunId = null; state.handoffProgress = null; renderActivity(document, state); }
  }
  async function executeCalls(calls, run) {
    const results = [];
    for (let index = 0; index < calls.length; index++) {
      checkRun(run);
      if (index > 0 && await refreshProjectInstructions(run, calls.slice(index))) {
        await appendHistory(run, 'system', 'Project instructions changed after an earlier call in this response. Earlier recorded tool results remain executed. None of the remaining calls executed. Review the current instructions and regenerate only the remaining actions; do not repeat successful calls.', { kind: 'instructions-update' });
        log('Project instructions changed during the tool batch; remaining actions need review.');
        return results;
      }
      const call = calls[index];
      const id = `${run.id}:${run.data.iterationCount}:${index}`;
      // Persist intent BEFORE effects. A reload offers inspection/resumption and
      // never automatically repeats a tool whose result may have been lost.
      await appendHistory(run, 'system', `Executing ${call.tool}`, { kind: 'tool-intent', tool_call_id: id, tool: call.tool, args: call.args, summary: call.summary || '' });
      setStatus('Running ' + call.tool + '...');
      const mode = permissionMode(state.permissionMode);
      const denied = { tool: call.tool, ok: false, error: { code: 'E_USER_DENIED', message: 'User denied this operation' } };
      let approved = false;
      if (mode === 'always') {
        approved = await showConfirm(call.tool, call.args, 'Ask every time is selected.', run.controller.signal);
        checkRun(run);
      }
      let result = mode === 'always' && !approved ? denied : await callBridgeTool(call.tool, call.args);
      if (!result.ok && result.error.code === 'E_NEEDS_CONFIRM') {
        const allowed = mode === 'full' || approved || await showConfirm(call.tool, call.args, result.error.message, run.controller.signal);
        checkRun(run);
        result = allowed ? await callBridgeTool(call.tool, call.args, result.error.extra?.confirmToken) : denied;
      }
      // A handoff may have been accepted just as Stop was clicked: cancel it
      // before checking the signal so it cannot remain running invisibly.
      if (result.ok && call.tool === 'dsh_handoff' && result.data?.runId) {
        const remoteId = result.data.runId;
        if (run.controller.signal.aborted) { await cancelHandoff(remoteId); throw aborted(); }
        run.data.handoffRunId = remoteId;
        let completed;
        try {
          await saveRun(run);
          completed = await pollHandoff(remoteId, result.data.timeoutMs, run);
        } catch (error) {
          if (run.controller.signal.aborted) await cancelHandoff(remoteId).catch((cancelError) => log(cancelError.message));
          throw error;
        }
        Object.assign(result, handoffResult(completed));
        run.data.handoffRunId = null;
      }
      if (call.tool === 'dsh_handoff' && result.error?.code === 'E_MISSING_CREDENTIAL' && state.health?.dsh) state.health.dsh.available = false;
      await appendHistory(run, 'tool', JSON.stringify(result), { tool_call_id: id, tool: call.tool, result });
      if (call.tool === 'dsh_read' && ['E_PATH_ESCAPE', 'E_ROOT_NOT_ALLOWED'].includes(result.error?.code)) {
        const requested = String(call.args.path || '').replace(/\\/g, '/').replace(/^(?:\.\.\/)+/, '');
        const savedOutput = [...run.data.conversationHistory].reverse().find((entry) => entry.result?.ok && [entry.result.data?.fullOutputFile, entry.result.data?.textOutputFile].includes(requested));
        const data = savedOutput?.result.data;
        if (data) {
          const jsonField = { dsh_bash: 'stdout', dsh_read: 'content', dsh_tree: 'tree', dsh_git_diff: 'diff' }[savedOutput.tool];
          const readWith = data.readWith || { tool: 'dsh_read', args: { path: data.fullOutputFile, workspace: data.fullOutputWorkspace || savedOutput.workspace, offset: 1, limit: 80, ...(jsonField ? { jsonField } : {}) } };
          await appendHistory(run, 'system', 'The saved output path is relative to its bridge workspace, not the directory selected by cd. Keep the path guards intact and use this exact call: ' + JSON.stringify(readWith), { kind: 'tool-recovery' });
        }
      }
      results.push(result);
      checkRun(run);
      if (result.error?.code === 'E_BRIDGE_UNREACHABLE') throw fail(result.error.message);
    }
    return results;
  }

  // The only task driver: send accumulated history -> await streaming completion
  // -> parse -> execute -> persist results -> repeat. Observer callbacks never
  // execute tools, so re-entrant mutations cannot start a second iteration.
  async function agentLoop(run, { task, resume = false, handshake = false, draft = '', recoveredHandoff, nativeSubmission = false, baseline }) {
    if (resume && run.data.handoffRunId && !recoveredHandoff) recoveredHandoff = await pollHandoff(run.data.handoffRunId, 1800000, run);
    if (recoveredHandoff) {
      const intent = [...run.data.conversationHistory].reverse().find((entry) => entry.kind === 'tool-intent' && entry.tool === 'dsh_handoff');
      const result = handoffResult(recoveredHandoff);
      if (!intent || !run.data.conversationHistory.some((entry) => entry.role === 'tool' && entry.tool_call_id === intent.tool_call_id)) {
        await appendHistory(run, 'tool', JSON.stringify(result), { tool: 'dsh_handoff', tool_call_id: intent?.tool_call_id, result });
      }
      run.data.handoffRunId = null;
    }
    if (handshake) await appendHistory(run, 'system', buildProtocolMessage(), { kind: 'protocol' });
    else if (resume) await appendHistory(run, 'system', 'Resume this task. Recorded tool results have already executed. If an execution intent has no result, inspect the workspace before acting; do not blindly repeat writes or commands.');
    else await appendHistory(run, 'user', task);
    const latestTask = [...run.data.conversationHistory].reverse().find((entry) => entry.role === 'user');
    run.initCommand = handshake ? null : initCommand(latestTask?.content);
    if (resume) run.instructionCalls = [...run.data.conversationHistory].reverse().find((entry) => entry.role === 'assistant' && entry.tool_calls?.length && !entry.parseErrors?.length)?.tool_calls;
    if (run.initCommand) log('Initializing project instructions: ' + run.initCommand.target);
    if (!handshake && !state.health?.capabilities?.projectInstructions) log('Automatic project instructions require an updated bridge. The agent will use file tools to inspect AGENTS.md.');
    let nextMessage = handshake ? buildProtocolMessage() : null;
    while (true) {
      checkRun(run);
      if (!handshake && run.data.iterationCount >= state.loopLimit) throw fail(`Hard iteration limit reached (${state.loopLimit}). Increase the limit in Settings before resuming.`, 'E_ITERATION_LIMIT');
      if (!handshake && !nativeSubmission && run.data.pendingToolResults && state.toolResultDelaySeconds > 0) {
        run.data.stage = 'cooldown';
        await saveRun(run);
        setStatus(`Waiting ${state.toolResultDelaySeconds}s before sending tool results...`);
        await sleep(Math.round(state.toolResultDelaySeconds * 1000), run.controller.signal);
        checkRun(run);
      }
      if (!handshake) await refreshProjectInstructions(run, run.instructionCalls || []);
      if (!handshake) run.data.iterationCount++;
      run.data.stage = 'waiting';
      run.data.inProgress = true;
      await saveRun(run);
      state.loopsLeft = state.loopLimit - run.data.iterationCount;
      const outbound = nextMessage ? nextMessage + (handshake ? '' : '\n\n' + buildHistoryMessage(run)) : buildHistoryMessage(run);
      nextMessage = null;
      // Attachment-only messages are submitted by the page itself. Observe that
      // response once; never resend the attachment or invent its file contents.
      const waiter = nativeSubmission ? waitForAssistant(run, baseline) : await sendText(outbound, run, draft);
      nativeSubmission = false;
      await adoptConversation(run);
      draft = '';
      setStatus('Waiting for DeepSeek...');
      const response = await waiter.promise;
      await adoptConversation(run);
      run.allowNewConversation = false;
      checkRun(run);
      const parsed = protocol.parse(response.raw, { maxCalls: MAX_CALLS, knownTools: availableTools().map((tool) => tool.name), renderedRanges: response.renderedRanges });
      if (!handshake) run.data.pendingToolResults = false;
      const needsInstructionCheck = !handshake && !parsed.errors.length && parsed.calls.length > 0 && state.health?.capabilities?.projectInstructions;
      // Preserve the raw proposal before discovery, including if its approval is
      // denied, the bridge fails, or Stop interrupts the instruction check.
      const entry = await appendHistory(run, 'assistant', parsed.text, { raw: response.raw, tool_calls: parsed.calls, narration: parsed.narration, parseErrors: parsed.errors, repaired: parsed.repaired, completion: response.completion, ...(needsInstructionCheck ? { deferred: true } : {}) });
      const deferred = needsInstructionCheck && await refreshProjectInstructions(run, parsed.calls);
      if (needsInstructionCheck && !deferred) { delete entry.deferred; await saveRun(run); }
      if (handshake) {
        if (!/\b(?:protocol\s+understood|understood|acknowledged|ready|ok(?:ay)?|confirmed)\b|已理解|理解协议|收到|好的|明白|确认/i.test(parsed.text)) throw fail('DeepSeek did not confirm the protocol. See the recorded response and try Enable again.');
        state.enabled = true;
        log('Protocol confirmed. Ready for tasks.');
        return 'ready';
      }
      if (deferred) {
        run.instructionCalls = parsed.calls;
        await appendHistory(run, 'system', 'New or changed project instructions apply to the requested paths. No calls from the preceding response executed. Review the current AGENTS.md instructions and regenerate the appropriate action before continuing.', { kind: 'instructions-update' });
        log('Loaded updated project instructions; asking the agent to review them before tools execute.');
        continue;
      }
      if (parsed.errors.length) {
        showParserError(parsed.errors, response.completion);
        run.data.retryCount++;
        const recovery = recoveryMessage(parsed, run, response.completion);
        await appendHistory(run, 'system', recovery, { kind: 'parse-error', retryCount: run.data.retryCount });
        if (run.data.retryCount > MAX_RETRIES) throw fail('Malformed tool calls persisted after two retries. Task paused; inspect the exact raw JSON in the panel.', 'E_PARSE_RETRIES');
        nextMessage = recovery;
        continue;
      }
      if (parsed.repaired) log('Repaired malformed tool JSON; continuing with validated arguments.');
      run.data.retryCount = 0;
      if (parsed.calls.length === 0) {
        log('Task complete: ' + (parsed.done ?? parsed.text).slice(0, 160));
        return 'completed';
      }
      run.data.stage = 'executing';
      await saveRun(run);
      await executeCalls(parsed.calls, run);
      run.instructionCalls = parsed.calls;
    }
  }

  async function startRun(options) {
    if (disposed) throw aborted();
    if (state.run) throw fail('An agent task is already active. Stop it before starting another.');
    const run = { id: crypto.randomUUID(), url: conversationUrl(), controller: new AbortController(), data: null, allowNewConversation: ['/', '/a/chat', '/a/chat/'].includes(location.pathname) };
    state.run = run;
    setStatus('Starting task...');
    run.promise = (async () => {
      let claimed = false;
      let heartbeat;
      let outcome = 'error';
      try {
        await message({ type: 'conversationClaim', url: run.url, runId: run.id });
        claimed = true;
        run.data = await loadConversation(run.url);
        if (typeof run.data.pendingToolResults !== 'boolean') {
          const lastTool = run.data.conversationHistory.findLastIndex((entry) => entry.role === 'tool');
          run.data.pendingToolResults = lastTool >= 0 && !run.data.conversationHistory.slice(lastTool + 1).some((entry) => entry.role === 'assistant');
        }
        if (!options.resume && !options.handshake) Object.assign(run.data, { iterationCount: 0, retryCount: 0, writeFailures: 0 });
        run.data.retryCount ||= 0; run.data.writeFailures ||= 0;
        if (options.resume) run.data.retryCount = 0;
        run.data.runId = run.id;
        run.data.workspace = state.workspace;
        heartbeat = scheduleInterval(() => {
          try { checkRun(run); } catch { run.controller.abort(); return; }
          message({ type: 'conversationHeartbeat', url: run.url, runId: run.id }).catch((error) => { log(error.message); run.controller.abort(); });
        }, 10000);
        outcome = await agentLoop(run, options);
      } catch (error) {
        outcome = error.code === 'E_STOPPED' ? 'stopped' : 'error';
        log(error.message);
        setStatus(outcome === 'stopped' ? 'Stopped' : 'Paused: ' + error.message);
      } finally {
        clearInterval(heartbeat);
        if (claimed && run.data) {
          run.data.inProgress = !options.handshake && !['completed', 'ready'].includes(outcome);
          run.data.stage = outcome;
          run.data.updatedAt = new Date().toISOString();
          // A cancelled signal must not prevent the terminal checkpoint write.
          try {
            const saved = await message({ type: 'conversationSave', url: run.url, runId: run.id, data: run.data });
            run.data.revision = saved.revision;
            state.checkpoint = run.data;
          } catch (error) { log('Checkpoint save failed: ' + error.message); }
        }
        if (claimed) await message({ type: 'conversationRelease', url: run.url, runId: run.id }).catch((error) => log(error.message));
        if (state.run === run) state.run = null;
        setStatus(['completed', 'ready'].includes(outcome) ? (state.enabled ? 'Ready' : 'Disabled') : state.status);
        updateResumeButton();
      }
    })();
    return run.promise;
  }
  async function doStop() {
    const run = state.run;
    if (!run) return;
    run.controller.abort();
    const stop = findStopButton();
    if (enabledButton(stop)) {
      state.automaticSend = true;
      try { stop.click(); } finally { state.automaticSend = false; }
    }
    if (run.handoffRunId || run.data?.handoffRunId) {
      const remoteId = run.handoffRunId || run.data.handoffRunId;
      try { await cancelHandoff(remoteId); } catch (error) { log('Handoff cancellation failed: ' + error.message); }
    }
    await run.promise;
  }
  async function submitTask(task, draft = task, options = {}) {
    if (state.pendingTask) return;
    state.pendingTask = true;
    try {
      await doStop();
      if (!state.connected) await doConnectTest();
      if (!state.connected) throw fail('Connect to the bridge before sending an agent task.');
      const running = startRun({ task, draft, ...options });
      state.pendingTask = false;
      await running;
    } catch (error) { log(error.message); setStatus('Paused: ' + error.message); }
    finally { state.pendingTask = false; }
  }
  function captureSubmission(event) {
    if (!state.enabled || state.automaticSend) return;
    const input = findInput();
    const text = inputText(input);
    if (!input) return;
    if (event.type === 'keydown') {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || !(event.target === input || input.contains(event.target))) return;
    } else if (event.type === 'click') {
      const button = findSendButton();
      if (!button || !(event.target === button || button.contains(event.target))) return;
    } else if (event.target !== input.closest('form')) return;
    if (!text.trim()) {
      if (!enabledButton(findSendButton()) || state.run || state.pendingTask) return;
      const files = Array.from(composerScope(input).querySelectorAll('input[type="file"]')).flatMap((el) => Array.from(el.files || [], (file) => file.name));
      const task = '[User submitted an attachment-only message in the DeepSeek chat' + (files.length ? ': ' + files.join(', ') : '') + '. Read the attached task in this conversation.]';
      submitTask(task, '', { nativeSubmission: true, baseline: assistantSnapshot() }).catch((error) => log(error.message));
      return; // Allow the native page handler to send the user's attachments.
    }
    // Take ownership before the page sends the unwrapped task. The original
    // draft remains visible until the cancellable preview has completed.
    event.preventDefault(); event.stopImmediatePropagation();
    submitTask(text).catch((error) => log(error.message));
  }

  function buildPanel() {
    return mountPanel(document, {
      connect: doConnectTest, enable: doEnable, stop: doStop, reset: doReset,
      diagnose: doDiagnose, resume: doResume, saveSettings, savePermissions,
      workspace(value) { state.workspace = value; void browser.storage.local.set({ workspace: value }); },
    });
  }

  function renderPermissions() {
    document.getElementById('dshpro-permissions').value = state.permissionMode;
    document.getElementById('dshpro-permissions-description').textContent = PERMISSION_MODES[state.permissionMode].description;
  }
  async function savePermissions() {
    const select = document.getElementById('dshpro-permissions');
    try {
      if (state.run) throw fail('Stop the current task before changing permissions.');
      const mode = permissionMode(select.value);
      select.disabled = true;
      await browser.storage.local.set({ permissionMode: mode });
      state.permissionMode = mode;
      log('Permissions saved: ' + PERMISSION_MODES[mode].label + '.');
    } catch (error) { log('Permissions were not saved: ' + error.message); }
    finally { renderPermissions(); select.disabled = Boolean(state.run); }
  }

  function refreshLoops() {
    if (disposed) return;
    const label = document.getElementById('dshpro-loops');
    if (label) label.textContent = `${Math.max(0, state.loopsLeft)}/${state.loopLimit}`;
    renderPanelState(document, state);
  }
  function updateResumeButton() {
    const button = document.getElementById('dshpro-resume');
    if (button) button.hidden = Boolean(state.run || !state.checkpoint?.inProgress);
  }
  async function doConnectTest() {
    try {
      if (!state.token) {
        showPanelView(document, 'settings');
        throw fail('Copy token in the DeepDock desktop app, then paste it in Settings > Bridge token and click Save settings.');
      }
      const health = await bridge('GET', '/health');
      if (!health?.json?.ok) throw fail(health?.status === 401 ? 'Token rejected. Click Copy token in the DeepDock desktop app, then update Settings > Bridge token and save.' : health?.json?.error?.message || health?.error || `Bridge health check failed (HTTP ${health?.status || 0}). Open the DeepDock desktop app and click Start bridge.`);
      const tools = await bridge('GET', '/tools');
      if (!tools?.json?.ok || !Array.isArray(tools.json.tools)) throw fail(tools?.json?.error?.message || tools?.error || 'Bridge tool definitions are unavailable.');
      state.connected = true; state.health = health.json; state.tools = tools.json; state.bridgeError = '';
      const daily = await browser.storage.local.get({ dailyLimit: 200 });
      state.dailyLimit = Number(daily.dailyLimit) || 200;
      const select = document.getElementById('dshpro-workspace');
      select.innerHTML = '';
      for (const root of health.json.allowedRoots) { const option = document.createElement('option'); option.value = root; option.textContent = root; select.appendChild(option); }
      if (!health.json.allowedRoots.includes(state.workspace)) state.workspace = health.json.allowedRoots[0] || '';
      select.value = state.workspace;
      log(`Bridge connected: ${tools.json.tools.length} tools${health.json.buildId ? ', build ' + health.json.buildId.slice(0, 12) : ' (legacy build)'}. dsh runtime: ` + (health.json.dsh?.binFound ? (health.json.dsh.available === false ? 'Found; handoff unavailable: ' + health.json.dsh.reason : 'Found; provider credentials unverified') : 'Not found (handoff unavailable)'));
      if (!tools.json.tools.some((tool) => tool.name === 'dsh_git_push')) log('The connected bridge has no GitHub publishing tools. Run scripts/start-deepdock.cmd to refresh the installed bridge.');
    } catch (error) { state.connected = false; state.bridgeError = error.message; log('Connection failed: ' + error.message); }
    setStatus(!state.connected ? 'Paused: ' + state.bridgeError : state.run ? state.status : state.enabled ? 'Ready' : 'Disabled');
  }
  async function doEnable() {
    try {
      if (state.run) throw fail('Stop the current task before enabling again.');
      if (state.enabled) {
        state.enabled = false;
        setStatus('Disabled');
        log('Agent disabled. Messages will use DeepSeek normally.');
        return;
      }
      if (!state.connected) await doConnectTest();
      if (!state.connected) return;
      await startRun({ handshake: true });
    } catch (error) { log(error.message); }
  }
  async function doReset() {
    await doStop();
    const url = conversationUrl();
    const runId = crypto.randomUUID();
    let claimed = false;
    try {
      await message({ type: 'conversationClaim', url, runId }); claimed = true;
      const data = await loadConversation(url);
      data.iterationCount = 0; data.retryCount = 0; data.writeFailures = 0;
      const saved = await message({ type: 'conversationSave', url, runId, data });
      data.revision = saved.revision; state.checkpoint = data;
      state.loopsLeft = state.loopLimit;
      setStatus(state.enabled ? 'Ready' : 'Disabled');
      log('Iteration budget reset. Conversation history and recorded tool results have been preserved.');
      updateResumeButton();
    } catch (error) { log('Reset failed: ' + error.message); }
    finally { if (claimed) await message({ type: 'conversationRelease', url, runId }).catch((error) => log(error.message)); }
  }
  async function doResume() {
    try {
      await doConnectTest();
      if (!state.connected) return;
      state.enabled = true;
      const saved = await loadConversation();
      if (saved.workspace && state.health.allowedRoots.includes(saved.workspace)) state.workspace = saved.workspace;
      // Reattach to an outstanding handoff without starting a second local agent.
      await startRun({ resume: true });
    } catch (error) { log(error.message); setStatus('Paused: ' + error.message); }
  }
  function doDiagnose() {
    const lines = [`status=${state.status} connected=${state.connected} enabled=${state.enabled} iteration=${state.run?.data?.iterationCount ?? state.checkpoint?.iterationCount ?? 0}/${state.loopLimit} history=${state.conversationHistory.length}`];
    if (state.bridgeError) lines.push('bridge: ' + state.bridgeError);
    const lastCapture = [...state.conversationHistory].reverse().find((entry) => entry.role === 'assistant');
    const currentSnapshot = assistantSnapshot();
    if (lastCapture) lines.push(`Last saved assistant capture: ${JSON.stringify(lastCapture.completion || {})}; rawChars=${lastCapture.raw?.length || 0}`);
    lines.push(`Current assistant DOM: message=${currentSnapshot.el?.getAttribute('data-virtual-list-item-key') || '(no key)'}; ${currentSnapshot.raw.length} characters; tail=${JSON.stringify(currentSnapshot.raw.slice(-300))}`);
    for (const kind of ['assistantMessage', 'assistantMarkdown', 'input', 'sendButton', 'stopButton', 'continueButton', 'responseComplete']) {
      const matches = selList(kind).map((selector) => {
        try { return `${selector} (${document.querySelectorAll(selector).length})`; } catch { return selector + ' (INVALID)'; }
      });
      lines.push(`${kind}: ${matches.join(' | ') || '(none)'}`);
    }
    for (const [name, el] of [['input', findInput()], ['sendButton', findSendButton()], ['assistant', findLastAssistant()]]) lines.push(`${name}: ${el ? `<${el.tagName.toLowerCase()} class="${el.className}" aria-label="${el.getAttribute('aria-label') || ''}">` : 'not found'}`);
    log(lines.join('\n'));
  }
  async function saveSettings() {
    const feedback = document.getElementById('dshpro-settings-feedback');
    try {
      if (state.run) throw fail('Stop the current task before changing Settings.');
      const custom = document.getElementById('dshpro-sel').value.trim();
      const selectors = custom ? JSON.parse(custom) : null;
      if (selectors && (Array.isArray(selectors) || typeof selectors !== 'object' || Object.values(selectors).some((value) => typeof value !== 'string' && !(Array.isArray(value) && value.every((entry) => typeof entry === 'string'))))) throw fail('Custom selectors must be an object of strings or arrays of strings.');
      const limit = Number(document.getElementById('dshpro-looplimit').value);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw fail('Iteration limit must be an integer from 1 to 1000.');
      const delayText = document.getElementById('dshpro-result-delay').value.trim();
      const delaySeconds = Number(delayText);
      if (!delayText || !Number.isFinite(delaySeconds) || delaySeconds < 0 || delaySeconds > MAX_TOOL_RESULT_DELAY_SECONDS) throw fail(`Tool result delay must be a number from 0 to ${MAX_TOOL_RESULT_DELAY_SECONDS} seconds.`);
      const baseUrl = normalizeBridgeUrl(document.getElementById('dshpro-baseurl').value.trim());
      const previous = await browser.storage.local.get(['token', 'baseUrl']);
      const tokenField = document.getElementById('dshpro-token');
      const token = tokenField.value.trim() || previous.token || '';
      if (!token) throw fail('Copy token in the DeepDock desktop app, then paste it in Bridge token above.');
      await browser.storage.local.set({ token, baseUrl, loopLimit: limit, toolResultDelaySeconds: delaySeconds, customSelectors: selectors });
      tokenField.value = '';
      tokenField.placeholder = token ? 'Saved token · leave blank to keep it' : 'Paste the token from the DeepDock app';
      state.token = token; state.loopLimit = limit; state.toolResultDelaySeconds = delaySeconds; state.customSelectors = selectors; state.loopsLeft = limit;
      if (previous.token !== token || previous.baseUrl !== baseUrl) { state.connected = false; state.enabled = false; setStatus('Disabled'); }
      log('Settings saved.'); refreshLoops();
      if (feedback) feedback.textContent = 'Settings saved. Test the connection, then enable the agent.';
    } catch (error) {
      log('Settings were not saved: ' + error.message);
      if (feedback) feedback.textContent = error.message;
    }
  }
  async function init() {
    if (disposed) return;
    buildPanel();
    const settings = await browser.storage.local.get(['token', 'baseUrl', 'loopLimit', 'toolResultDelaySeconds', 'customSelectors', 'workspace', 'permissionMode']);
    if (disposed) return;
    Object.assign(state, { token: settings.token || '', loopLimit: Math.min(1000, Math.max(1, Number(settings.loopLimit) || DEFAULT_LOOP_LIMIT)), toolResultDelaySeconds: normalizeToolResultDelaySeconds(settings.toolResultDelaySeconds), customSelectors: settings.customSelectors || null, workspace: settings.workspace || '' });
    state.permissionMode = permissionMode(settings.permissionMode);
    renderPermissions();
    state.loopsLeft = state.loopLimit;
    // Saved credentials stay out of the host page's DOM.
    document.getElementById('dshpro-token').placeholder = state.token ? 'Saved token · leave blank to keep it' : 'Paste the token from the DeepDock app';
    document.getElementById('dshpro-baseurl').value = settings.baseUrl || 'http://127.0.0.1:8765';
    document.getElementById('dshpro-looplimit').value = state.loopLimit;
    document.getElementById('dshpro-result-delay').value = state.toolResultDelaySeconds;
    document.getElementById('dshpro-sel').value = state.customSelectors ? JSON.stringify(state.customSelectors) : '';
    state.checkpoint = await loadConversation();
    if (disposed) return;
    state.conversationHistory = state.checkpoint.conversationHistory;
    updateResumeButton();
    if (state.checkpoint.inProgress) log(`An unfinished task has ${state.checkpoint.iterationCount} recorded iterations. Click Resume task to continue after reviewing the chat.`);
    setStatus('Disabled');
    if (state.token) await doConnectTest();
    else log('First use: open the DeepDock desktop app, click Start bridge and Copy token. Open Settings > Bridge token in this panel, paste and Save settings, then Test connection and Enable agent. Source users can copy the token with scripts/pair.ps1.');
    if (disposed) return;
    for (const type of ['click', 'keydown', 'submit']) document.addEventListener(type, captureSubmission, true);
    // Navigation changes the persistence namespace and never carries a task into
    // an unrelated chat. The active loop is cancelled before loading that chat.
    let currentUrl = conversationUrl();
    navigationTimer = scheduleInterval(async () => {
      if (disposed || conversationUrl() === currentUrl) return;
      currentUrl = conversationUrl();
      if (state.run?.allowNewConversation || state.run?.url === currentUrl) return;
      await doStop(); state.enabled = false;
      try { state.checkpoint = await loadConversation(); state.conversationHistory = state.checkpoint.conversationHistory; updateResumeButton(); setStatus('Disabled'); }
      catch (error) { log(error.message); }
    }, 1000);
  }
  async function dispose() {
    if (disposed) return;
    disposed = true;
    clearInterval(navigationTimer);
    for (const type of ['click', 'keydown', 'submit']) document.removeEventListener(type, captureSubmission, true);
    // Invalidation must leave a resumable checkpoint and remove every page listener.
    document.getElementById('dshpro-panel')?.remove();
    await doStop();
  }
  return {
    state, init, dispose, startRun, doStop, doResume, doReset, doConnectTest,
    agentLoop, buildProtocolMessage, showConfirm, executeCalls, pollHandoff,
  };
}
