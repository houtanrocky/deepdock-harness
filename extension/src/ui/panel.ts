import { PERMISSION_MODES, type PanelState } from '../contracts.ts';

interface PanelActions {
  connect: () => Promise<void>;
  enable: () => Promise<void>;
  stop: () => Promise<void>;
  reset: () => Promise<void>;
  diagnose: () => void;
  resume: () => Promise<void>;
  saveSettings: () => Promise<void>;
  savePermissions: () => Promise<void>;
  workspace: (value: string) => void;
}

const icons = {
  mark: '<path fill="#21c6ad" stroke="none" d="M3 14c0-4.6 3.4-8 7.7-8h4.1c2.5 0 4 1.5 4.5 4l2.2.7c.8.2 1.3.9 1.3 1.7 0 .7-.5 1.4-1.2 1.7l-2.4.8C19.9 18.3 17 20 12.8 20H8.8A5.8 5.8 0 0 1 3 14.2Z"/><path fill="#f4b72b" stroke="none" d="m17.5 10.5 4.1 1.2c.8.2 1.3.9 1.3 1.7 0 .7-.5 1.4-1.2 1.7l-4.2 1.4-2.2-2.6Z"/><circle cx="13" cy="10" r="1.9" fill="#f7fbfc" stroke="none"/><circle cx="13.5" cy="10" r=".85" fill="#12222b" stroke="none"/>',
  settings: '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a8 8 0 0 1-2.5 1.4L15 21h-3l-.4-1.7a8 8 0 0 1-2.5-1.4l-1.7.7L6 16.2l1.4-1.1a8 8 0 0 1 0-2.8L6 11.2l1.4-2.4 1.7.7a8 8 0 0 1 2.5-1.4L12 6h3l.4 2.1a8 8 0 0 1 2.5 1.4l1.7-.7 1.4 2.4-1.4 1.1a8 8 0 0 1-.2 2.7Z" transform="translate(-1 -1)"/>',
  collapse: '<path d="m6 14 6-6 6 6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6Z"/><path d="m8 12 3 3 5-6"/>',
  play: '<path d="m9 5 11 7-11 7Z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  link: '<path d="m10 13 4-4m-6 7-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 2 1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(2 0)"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
};
function icon(name: keyof typeof icons): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
}

export function mountPanel(document: Document, actions: PanelActions): HTMLElement {
  const existing = document.getElementById('dshpro-panel');
  if (existing) return existing;
  const panel = document.createElement('section');
  panel.id = 'dshpro-panel';
  panel.className = 'dshpro-panel';
  panel.setAttribute('aria-label', 'DeepDock Harness');
  panel.innerHTML = `
    <header class="dshpro-head">
      <span class="dshpro-brand-icon">${icon('mark')}</span>
      <div class="dshpro-brand"><span class="dshpro-title">DeepDock Harness</span><span class="dshpro-eyebrow">YOUR LOCAL AGENT</span></div>
      <span class="dshpro-dot" id="dshpro-dot" aria-hidden="true"></span>
      <button class="dshpro-icon-btn" id="dshpro-settings-toggle" aria-label="Settings" aria-expanded="false" aria-controls="dshpro-settings">${icon('settings')}</button>
      <button class="dshpro-icon-btn" id="dshpro-toggle" aria-label="Collapse panel" aria-expanded="true" aria-controls="dshpro-body">${icon('collapse')}</button>
    </header>
    <div class="dshpro-body" id="dshpro-body">
      <div id="dshpro-agent-view">
        <div class="dshpro-status-card">
          <div class="dshpro-status-top"><span class="dshpro-eyebrow">AGENT STATUS</span><span class="dshpro-badge" id="dshpro-connection">OFFLINE</span></div>
          <div class="dshpro-phase" id="dshpro-phase" role="status" aria-live="polite">Disabled</div>
          <p class="dshpro-hint" id="dshpro-status-description">Connect your bridge to bring local tools into this chat.</p>
          <div class="dshpro-budget"><span>Iteration budget</span><span id="dshpro-loops">0 / 15</span></div>
          <progress id="dshpro-progress" max="15" value="15" aria-label="Iterations remaining"></progress>
        </div>
        <div class="dshpro-actions">
          <button class="dshpro-btn primary" id="dshpro-enable">${icon('play')}<span>Enable agent</span></button>
          <button class="dshpro-btn danger" id="dshpro-stop" disabled>${icon('stop')}<span>Stop</span></button>
        </div>
        <button class="dshpro-btn dshpro-resume" id="dshpro-resume" hidden>Resume unfinished task ${icon('arrow')}</button>
        <section class="dshpro-history" aria-label="Agent activity history">
          <div class="dshpro-section-head"><h2>Conversation</h2><button class="dshpro-text-btn" id="dshpro-history-size" aria-pressed="false">Expand history</button></div>
          <p class="dshpro-current-action" id="dshpro-current-action" role="status" aria-live="polite">Ready for a task</p>
          <details class="dshpro-file-changes" id="dshpro-file-changes" hidden></details>
          <div class="dshpro-timeline" id="dshpro-timeline" role="region" aria-label="Conversation history" tabindex="0"></div>
        </section>
        <div class="dshpro-config">
          <div class="dshpro-field"><label class="dshpro-label" for="dshpro-workspace">${icon('folder')}Workspace</label>
            <select class="dshpro-select" id="dshpro-workspace"><option value="">Connect to load workspaces</option></select></div>
          <div class="dshpro-field"><label class="dshpro-label" for="dshpro-permissions">${icon('shield')}Permissions</label>
            <select class="dshpro-select" id="dshpro-permissions" aria-describedby="dshpro-permissions-description">
              ${Object.entries(PERMISSION_MODES).map(([value, mode]) => `<option value="${value}">${mode.label}</option>`).join('')}
            </select><p class="dshpro-field-hint" id="dshpro-permissions-description"></p></div>
        </div>
        <button type="button" class="dshpro-preview" id="dshpro-preview" style="display:none" aria-label="Cancel outgoing message"></button>
        <div class="dshpro-confirm-box" id="dshpro-confirm" role="alertdialog" aria-labelledby="dshpro-confirm-title" aria-describedby="dshpro-confirm-text" style="display:none">
          <div class="dshpro-confirm-title" id="dshpro-confirm-title">Your approval is needed</div>
          <pre id="dshpro-confirm-text"></pre>
          <div class="dshpro-actions"><button class="dshpro-btn primary" id="dshpro-confirm-yes">Allow once</button><button class="dshpro-btn" id="dshpro-confirm-no">Deny</button></div>
        </div>
        <div class="dshpro-activity">
          <div class="dshpro-section-head"><h2>Activity</h2><button class="dshpro-text-btn" id="dshpro-reset" title="Reset the iteration budget; keep saved history">Reset budget</button></div>
          <details class="dshpro-debug"><summary>Diagnostics log</summary><div class="dshpro-log" id="dshpro-log"></div></details>
          <details class="dshpro-parser-error" id="dshpro-parser-error" hidden><summary>Last rejected response</summary><pre></pre></details>
        </div>
      </div>
      <div class="dshpro-settings" id="dshpro-settings" style="display:none">
        <div class="dshpro-settings-heading"><h2>Settings</h2><p class="dshpro-hint">Connect your device. Tune how your agent runs.</p></div>
        <div class="dshpro-field"><label class="dshpro-label" for="dshpro-baseurl">Bridge address</label><input class="dshpro-input" id="dshpro-baseurl" type="url" value="http://127.0.0.1:8765" spellcheck="false" autocomplete="off" /><p class="dshpro-field-hint">Local HTTP bridge on this device.</p></div>
        <div class="dshpro-field"><label class="dshpro-label" for="dshpro-token">Bridge token</label><input class="dshpro-input" id="dshpro-token" type="password" placeholder="Paste the token from pair.ps1" autocomplete="off" spellcheck="false" /><p class="dshpro-field-hint">Stored in this extension. Never sent to the chat.</p></div>
        <div class="dshpro-field"><label class="dshpro-label" for="dshpro-looplimit">Iteration limit</label><input class="dshpro-input" id="dshpro-looplimit" type="number" min="1" max="1000" /><p class="dshpro-field-hint">1–1000 rounds per task. Default: 15.</p></div>
        <details class="dshpro-advanced"><summary>Advanced selectors</summary><label class="dshpro-label" for="dshpro-sel">Custom selectors (JSON)</label><textarea class="dshpro-input" id="dshpro-sel" rows="3" placeholder='{"input":"textarea#chat-input"}' spellcheck="false"></textarea><p class="dshpro-field-hint">Override selectors when the DeepSeek layout changes.</p></details>
        <button class="dshpro-btn primary dshpro-save" id="dshpro-save">Save settings</button>
        <p class="dshpro-field-hint" id="dshpro-settings-feedback" role="status" aria-live="polite"></p>
      </div>
      <footer class="dshpro-footer"><button class="dshpro-text-btn" id="dshpro-test">${icon('link')}Test connection</button><span id="dshpro-tool-count">Local bridge</span><button class="dshpro-text-btn" id="dshpro-diag">Diagnostics</button></footer>
    </div>`;
  document.body.appendChild(panel);
  const element = <T extends HTMLElement>(id: string) => document.getElementById(`dshpro-${id}`) as T;
  let collapsed = false;
  element('history-size').onclick = () => {
    const wide = panel.classList.toggle('dshpro-wide');
    element('history-size').textContent = wide ? 'Compact history' : 'Expand history';
    element('history-size').setAttribute('aria-pressed', String(wide));
  };
  element('toggle').onclick = () => {
    collapsed = !collapsed;
    panel.classList.toggle('dshpro-min', collapsed);
    element('body').hidden = collapsed;
    element('toggle').setAttribute('aria-expanded', String(!collapsed));
    element('toggle').setAttribute('aria-label', collapsed ? 'Expand panel' : 'Collapse panel');
  };
  element('settings-toggle').onclick = () => {
    const settings = element('settings');
    const open = settings.style.display === 'none';
    settings.style.display = open ? 'block' : 'none';
    element('agent-view').hidden = open;
    element('settings-toggle').setAttribute('aria-expanded', String(open));
    if (collapsed) element('toggle').click();
    if (open) element('baseurl').focus();
  };
  for (const [id, action] of Object.entries({ enable: actions.enable, stop: actions.stop, reset: actions.reset, resume: actions.resume, save: actions.saveSettings })) {
    element(id).onclick = () => { void action(); };
  }
  element('test').onclick = async () => { await actions.connect(); showAgentView(document); };
  element('diag').onclick = () => { showAgentView(document); actions.diagnose(); };
  element<HTMLSelectElement>('permissions').onchange = () => { void actions.savePermissions(); };
  element<HTMLSelectElement>('workspace').onchange = () => actions.workspace(element<HTMLSelectElement>('workspace').value);
  return panel;
}

export function showAgentView(document: Document): void {
  const settings = document.getElementById('dshpro-settings');
  if (settings && settings.style.display !== 'none') document.getElementById('dshpro-settings-toggle')?.click();
  const toggle = document.getElementById('dshpro-toggle');
  if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click();
}

export function renderPanelState(document: Document, state: PanelState): void {
  const panel = document.getElementById('dshpro-panel');
  if (!panel) return;
  const button = (id: string) => document.getElementById(`dshpro-${id}`) as HTMLButtonElement;
  const active = Boolean(state.run);
  panel.dataset.running = String(active);
  panel.dataset.connected = String(state.connected);
  panel.dataset.enabled = String(state.enabled);
  button('stop').disabled = !active;
  button('enable').disabled = active;
  button('enable').setAttribute('aria-pressed', String(state.enabled));
  button('enable').querySelector('span')!.textContent = state.enabled ? 'Disable agent' : 'Enable agent';
  button('enable').querySelector('svg')!.innerHTML = icons[state.enabled ? 'stop' : 'play'];
  button('test').disabled = active;
  document.getElementById('dshpro-connection')!.textContent = state.connected ? 'CONNECTED' : 'OFFLINE';
  document.getElementById('dshpro-tool-count')!.textContent = state.connected ? `${state.tools?.tools.length || 0} tools available` : 'Local bridge';
  const progress = document.getElementById('dshpro-progress') as HTMLProgressElement;
  progress.max = state.loopLimit;
  progress.value = Math.max(0, state.loopsLeft);
  document.getElementById('dshpro-status-description')!.textContent = state.status.startsWith('Paused')
    ? 'Review Activity below, then resume when you are ready.'
    : active ? 'Working in this conversation. You can stop at any time.'
    : state.enabled ? 'Send a task in DeepSeek. Your agent will take it from here.'
    : state.connected ? 'Your workspace is connected. Enable the agent to get started.'
    : 'Connect your bridge to bring local tools into this chat.';
}
