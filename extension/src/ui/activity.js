import { activityView, activityText } from '../core/activity.js';

const views = new WeakMap();
const badges = { succeeded: 'Succeeded', failed: 'Failed', denied: 'Denied', uncertain: 'Outcome unknown', running: 'Running', approval: 'Awaiting approval' };

export function renderActivity(document, state) {
  const root = document.getElementById('dshpro-timeline');
  if (!root) return;
  let view = views.get(root);
  if (!view) { view = { limit: 60, nodes: new Map(), signatures: new Map() }; views.set(root, view); }
  const model = activityView(state.conversationHistory, { activeRunId: state.run?.id, approval: state.status === 'Awaiting approval' });
  if (state.handoffProgress) {
    const step = [...model.rows].reverse().find((row) => row.kind === 'tool' && row.tool === 'dsh_handoff' && row.status === 'running');
    if (step) step.progress = state.handoffProgress;
  }
  const clean = (value) => activityText(value, [state.token]);
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = clean(text);
    return element;
  }
  function detail(parent, title, value, className = '') {
    if (value === undefined || value === null || value === '') return;
    const details = node('details', 'dshpro-step-detail ' + className);
    details.append(node('summary', '', title));
    const text = clean(value);
    const pre = node('pre', '', text.length > 20000 ? text.slice(0, 20000) + '\n[Preview shortened]' : text);
    if (className === 'dshpro-file-diff' && text.length <= 20000) {
      pre.textContent = '';
      for (const line of text.split('\n')) {
        const type = line.startsWith('@@') ? 'range' : line.startsWith('+++') || line.startsWith('---') ? 'header' : line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : 'context';
        pre.append(node('span', 'dshpro-diff-' + type, line + '\n'));
      }
    }
    details.append(pre);
    if (text.length > 20000) {
      const button = node('button', 'dshpro-text-btn', 'Show full saved details');
      button.type = 'button';
      button.onclick = () => { pre.textContent = text; button.remove(); };
      details.append(button);
    }
    parent.append(details);
  }
  function renderRow(row) {
    const card = node('article', 'dshpro-event dshpro-event-' + row.kind);
    card.dataset.eventId = row.key;
    card.dataset.status = row.status || '';
    const head = node('div', 'dshpro-event-head');
    head.append(node('span', 'dshpro-event-title', row.title));
    if (row.status) head.append(node('span', 'dshpro-step-badge', badges[row.status]));
    card.append(head);
    if (row.timestamp) {
      const time = node('time', 'dshpro-event-time');
      time.dateTime = row.timestamp;
      time.textContent = new Date(row.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      card.append(time);
    }
    if (row.text || row.summary) card.append(node('p', 'dshpro-event-text', row.text || row.summary));
    if (row.kind !== 'tool') { detail(card, 'Recovery details', row.detail); return card; }
    card.append(node('p', 'dshpro-step-meta', row.tool + (row.durationMs !== undefined ? ` · ${(row.durationMs / 1000).toFixed(2)}s` : '') + (row.workspace ? ' · ' + row.workspace : '')));
    const sensitive = /(?:^|[\\/])\.env(?:\.|$)/i.test(String(row.args.path || ''));
    const args = sensitive ? { ...row.args, content: '[Sensitive file content hidden]', oldText: '[Hidden]', newText: '[Hidden]' } : row.args;
    if (row.args.command) detail(card, 'Command', row.args.command);
    detail(card, 'Arguments', args);
    const result = row.result;
    if (!result) {
      card.append(node('p', 'dshpro-step-note', row.status === 'uncertain' ? 'No final result was recorded. Inspect the workspace before retrying this step.' : row.status === 'approval' ? 'Waiting for your decision before this step can proceed.' : 'The bridge is executing this step.'));
      if (row.progress) {
        card.append(node('p', 'dshpro-step-note', `Local agent running for ${Math.floor((row.progress.elapsedMs || 0) / 1000)}s.`));
        detail(card, 'Live local-agent output', row.progress.liveTail);
      }
      return card;
    }
    if (result.error) card.append(node('p', 'dshpro-step-error', result.error.code + ': ' + result.error.message));
    const output = result.data || result.error?.extra || {};
    const change = output.change;
    if (change) {
      detail(card, 'File diff · ' + change.file, change.diff, 'dshpro-file-diff');
      if (change.note) card.append(node('p', 'dshpro-step-note', change.note));
    }
    if (output.stdout) detail(card, 'Standard output', output.stdout);
    if (output.stderr) detail(card, 'Standard error', output.stderr);
    if (output.diff) detail(card, 'Git diff', output.diff, 'dshpro-file-diff');
    if (output.fullOutputFile) card.append(node('p', 'dshpro-step-note', 'Full output saved to ' + output.fullOutputFile + (output.fullOutputWorkspace ? ' · workspace: ' + output.fullOutputWorkspace : '')));
    if (output.textOutputFile) card.append(node('p', 'dshpro-step-note', 'Line-readable output: ' + output.textOutputFile));
    detail(card, 'Read saved output', output.readWith);
    detail(card, 'Full result', result);
    return card;
  }

  const current = document.getElementById('dshpro-current-action');
  const pending = [...model.rows].reverse().find((row) => row.kind === 'tool' && ['running', 'approval'].includes(row.status));
  if (current) current.textContent = clean(state.run ? pending ? `${badges[pending.status]} · ${pending.summary || pending.title}` : state.status : state.checkpoint?.stage === 'completed' ? 'Task complete' : state.checkpoint?.inProgress ? 'Task paused · review the steps before resuming' : 'Ready for a task');
  const changes = document.getElementById('dshpro-file-changes');
  const changeSignature = JSON.stringify(model.changes);
  if (changes && view.changeSignature !== changeSignature) {
    view.changeSignature = changeSignature;
    changes.replaceChildren();
    changes.hidden = !model.changes.length;
    changes.append(node('summary', '', `${model.changes.length} ${model.changes.length === 1 ? 'file' : 'files'} changed`));
    changes.append(node('p', 'dshpro-step-note', 'Recorded file writes and edits. Command and local-agent output appears in their steps.'));
    for (const change of model.changes) {
      const button = node('button', 'dshpro-changed-file', `${change.file} · ${change.kind}${change.count > 1 ? ` · ${change.count} changes` : ''}`);
      button.type = 'button';
      if (change.workspace) button.title = change.workspace;
      button.onclick = () => {
        const index = model.rows.findIndex((row) => row.key === change.stepKey);
        view.limit = Math.max(view.limit, model.rows.length - index);
        renderActivity(document, state);
        const target = view.nodes.get(change.stepKey);
        const diff = target?.querySelector('.dshpro-file-diff');
        if (diff) diff.open = true;
        (diff || target)?.scrollIntoView({ block: 'nearest' });
      };
      changes.append(button);
    }
  }
  const follow = root.scrollHeight - root.clientHeight - root.scrollTop < 40;
  let previousScroll = root.scrollTop;
  const firstKey = model.rows[0]?.key;
  if (view.firstKey !== undefined && view.firstKey !== firstKey) {
    view.limit = 60; view.rowCount = model.rows.length; previousScroll = 0;
  } else if (!follow && view.rowCount && model.rows.length > view.rowCount) {
    // Keep the first visible historical step when new activity arrives.
    view.limit += model.rows.length - view.rowCount;
  }
  view.firstKey = firstKey; view.rowCount = model.rows.length;
  const fragment = document.createDocumentFragment();
  if (model.rows.length > view.limit) {
    const earlier = node('button', 'dshpro-text-btn', `Show earlier activity (${model.rows.length - view.limit})`);
    earlier.type = 'button';
    earlier.onclick = () => {
      const height = root.scrollHeight;
      const scroll = root.scrollTop;
      view.limit += 60;
      renderActivity(document, state);
      root.scrollTop = scroll + root.scrollHeight - height;
    };
    fragment.append(earlier);
  }
  const visible = model.rows.slice(-view.limit);
  const keep = new Set();
  for (const row of visible) {
    keep.add(row.key);
    const signature = JSON.stringify(row);
    let card = view.nodes.get(row.key);
    if (!card || view.signatures.get(row.key) !== signature) {
      const expanded = new Set([...card?.querySelectorAll('details[open]') || []].map((item) => item.querySelector('summary').textContent));
      card = renderRow(row);
      card.querySelectorAll('details').forEach((item) => { item.open = expanded.has(item.querySelector('summary').textContent); });
      view.nodes.set(row.key, card); view.signatures.set(row.key, signature);
    }
    fragment.append(card);
  }
  for (const key of view.nodes.keys()) if (!keep.has(key)) { view.nodes.delete(key); view.signatures.delete(key); }
  if (!model.rows.length) fragment.append(node('p', 'dshpro-history-empty', 'Your task, assistant updates, and tool results will appear here.'));
  root.replaceChildren(fragment);
  root.scrollTop = follow ? root.scrollHeight : previousScroll;
}
