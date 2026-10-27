const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

test('Windows setup configures pairing without launch or clipboard changes and removes legacy startup', { skip: process.platform !== 'win32' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepdock-setup-'));
  t.after(() => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('deepdock-setup-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const startup = path.join(root, 'Startup');
  const appData = path.join(root, 'profile');
  const workspace = path.join(root, 'project with spaces');
  fs.mkdirSync(startup);
  fs.mkdirSync(workspace);
  const shortcut = path.join(startup, 'DeepDock Harness Bridge.lnk');
  fs.writeFileSync(shortcut, 'legacy startup fixture');
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  // Redirect only the shell-owned startup location into the isolated fixture.
  // Keep setup's real configuration and migration behavior intact.
  const setup = fs.readFileSync(path.join(__dirname, '../../scripts/installer/setup.ps1'), 'utf8')
    .replace("[Environment]::GetFolderPath('Startup')", quote(startup));
  const script = `function Start-Process { throw 'Setup must not launch a bridge or app' }
function Set-Clipboard { throw 'Setup must not overwrite the clipboard' }
& { ${setup} } -Workspace ${quote(workspace)} -InstallDir ${quote(root)}`;
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  const run = () => exec('powershell.exe', args, { env: { ...process.env, APPDATA: appData }, windowsHide: true, timeout: 15000 });
  await run();
  const configPath = path.join(appData, 'DeepDock/config.json');
  const first = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.match(first.token, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.allowedRoots, [workspace]);
  assert.equal(fs.existsSync(shortcut), false);
  await run();
  const second = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(second.token, first.token);
  assert.deepEqual(fs.readdirSync(startup), []);
});
