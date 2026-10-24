import { protocol } from './protocol.js';

const titles = {
  dsh_tree: 'List files', dsh_read: 'Read', dsh_write: 'Write', dsh_edit: 'Edit',
  dsh_search: 'Search', dsh_bash: 'Run command', dsh_handoff: 'Run local agent',
  dsh_git_status: 'Check Git status', dsh_git_diff: 'Inspect Git diff', dsh_log: 'Read execution log',
};

export function toolTitle(tool, args = {}) {
  const title = tool === 'dsh_write' && args.append ? 'Append to' : titles[tool] || tool.replace(/^dsh_/, '').replaceAll('_', ' ');
  return title + (args.path ? ' ' + args.path : tool === 'dsh_bash' ? ': ' + (args.command || '') : tool === 'dsh_search' ? ': ' + (args.query || '') : '');
}

// This projection never changes the saved transcript or infers success from an
// intent. A lost result stays uncertain, including after a reload or Stop.
export function activityView(entries = [], { activeRunId, approval = false } = {}) {
  const results = new Map();
  const intentIds = new Set(entries.filter((entry) => entry.kind === 'tool-intent' && entry.tool_call_id).map((entry) => entry.tool_call_id));
  for (const entry of entries) if (entry.role === 'tool' && entry.tool_call_id) results.set(entry.tool_call_id, entry);
  const paired = new Set();
  const rows = [];
  const changes = new Map();
  function toolRow(intent, response, key) {
    let result = response?.result;
    if (!result && response?.content) { try { result = JSON.parse(response.content); } catch {} }
    const tool = intent?.tool || response?.tool || result?.tool || 'Tool';
    const args = intent?.args || {};
    const pending = !response && Boolean(activeRunId && intent?.runId === activeRunId);
    const uncertain = result?.error?.code === 'E_BRIDGE_UNREACHABLE' || (result?.error?.code === 'E_TIMEOUT' && result.error.extra?.terminationConfirmed === false);
    const status = result ? result.ok ? 'succeeded' : result.error?.code === 'E_USER_DENIED' ? 'denied' : uncertain ? 'uncertain' : 'failed' : pending ? approval ? 'approval' : 'running' : 'uncertain';
    const row = { key, kind: 'tool', title: toolTitle(tool, args), tool, args, result, status, summary: intent?.summary || '', timestamp: intent?.timestamp || response?.timestamp, durationMs: result?.durationMs, workspace: args.workspace || intent?.workspace || response?.workspace || '' };
    rows.push(row);
    if (result?.ok && ['dsh_write', 'dsh_edit'].includes(tool)) {
      const data = result.data || {};
      const file = data.change?.file || data.file || args.path;
      if (file && data.change?.kind !== 'unchanged') {
        const changeKey = row.workspace + '\0' + file;
        const previous = changes.get(changeKey);
        changes.set(changeKey, { file, workspace: row.workspace, count: (previous?.count || 0) + 1, kind: previous?.kind === 'created' || data.created ? 'created' : data.change?.kind || 'updated', stepKey: key });
      }
    }
  }
  entries.forEach((entry, index) => {
    const key = entry.id || 'entry:' + index;
    if (entry.kind === 'tool-intent') {
      const response = results.get(entry.tool_call_id);
      if (response) paired.add(response);
      toolRow(entry, response, key);
    } else if (entry.role === 'tool') {
      // Results normally follow their intent; legacy unpaired results remain visible.
      if (!paired.has(entry) && !intentIds.has(entry.tool_call_id)) toolRow(null, entry, key);
    } else if (entry.role === 'user') {
      rows.push({ key, kind: 'user', title: 'You', text: entry.content || '', timestamp: entry.timestamp });
    } else if (entry.role === 'assistant') {
      if (entry.parseErrors?.length || entry.deferred) return;
      if (!entry.tool_calls?.length && protocol.parse(entry.raw || entry.content || '').errors.some((error) => error.code === 'E_UNSUPPORTED_TOOL_FORMAT')) {
        rows.push({ key, kind: 'recovery', title: 'Unexecuted native tool markup', text: 'This saved response used unsupported tool markup. Review the recorded tool results for actions that actually ran.', detail: entry.content, timestamp: entry.timestamp });
        return;
      }
      const parsed = entry.narration === undefined ? protocol.parse(entry.content || '') : null;
      const calls = entry.tool_calls || parsed?.calls || [];
      const text = calls.length ? entry.narration ?? parsed?.narration ?? '' : (entry.content || '').replace(/^DSH:DONE[:：]\s*/i, '');
      if (text.trim() && !/^protocol understood\.?$/i.test(text.trim())) rows.push({ key, kind: 'assistant', title: calls.length ? 'Assistant update' : 'Assistant', text, timestamp: entry.timestamp });
    } else if (entry.kind === 'instructions-update') {
      rows.push({ key, kind: 'recovery', title: 'Project instructions updated', text: entry.content, timestamp: entry.timestamp });
    } else if (entry.kind === 'parse-error') {
      rows.push({ key, kind: 'recovery', title: 'Response rejected · retry ' + (entry.retryCount || 1), text: 'No calls from this response executed. The harness requested a corrected response.', detail: entry.content, timestamp: entry.timestamp });
    }
  });
  return { rows, changes: [...changes.values()] };
}

export function activityText(value, secrets = []) {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  return text.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[redacted]')
    .replace(/("(?:confirmToken|token|apiKey|password|authorization)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"[redacted]"');
}
