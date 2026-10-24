import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FixtureBridge, TOKEN, tool, queue, enable, submit, complete } from '../extension/test/e2e/fixtures.ts';

const project = fileURLToPath(new URL('../', import.meta.url));
process.chdir(project);
const kit = path.join(project, 'chrome-web-store-submission');
const svg = await fs.readFile('extension/src/assets/logo.svg', 'utf8');
const glyph = svg.match(/<g[^>]*>([\s\S]*?)<\/g>/)[1];
const inlineMark = '<svg viewBox="0 0 32 32" fill="none" aria-hidden="true">' + glyph + '</svg>';
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  for (const size of [16, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent('<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>' + svg);
    await page.screenshot({ path: 'extension/public/icons/icon' + size + '.png', omitBackground: true });
  }
  await fs.copyFile('extension/public/icons/icon128.png', 'docs/assets/icon128.png');
  await fs.copyFile('extension/public/icons/icon128.png', path.join(kit, 'extension/store-icon-128.png'));
  const social = await fs.readFile('docs/assets/social-card.svg', 'utf8');
  await fs.writeFile('docs/assets/social-card.svg', social.replace(/<g(?: id="brand-mark")? transform="translate\((?:71 53|69 48)\) scale\((?:1\.2|1\.05)\)">[\s\S]*?<\/g>/, '<g id="brand-mark" transform="translate(69 48) scale(1.05)">' + glyph + '</g>'));
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.goto(new URL('../docs/assets/social-card.svg', import.meta.url).href);
  await page.screenshot({ path: 'docs/assets/social-preview.png' });
  console.log('Exported blue whale icons (16, 48, 128 px) and social preview.');

  if (!process.argv.includes('--icons')) {
    await page.goto('about:blank');
    await fs.mkdir(path.join(kit, 'promotional'), { recursive: true });
    for (const [name, width, height] of [['small-promo-440x280.jpg', 440, 280], ['marquee-1400x560.jpg', 1400, 560]]) {
      await page.setViewportSize({ width, height });
      const small = width === 440;
      await page.setContent(`<!doctype html><html><head><style>
        *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{background:#101a2b;color:#f4f7ff;font-family:'Segoe UI',Arial,sans-serif}
        .orb{position:absolute;width:${small ? 290 : 710}px;height:${small ? 290 : 710}px;right:${small ? -85 : -50}px;top:${small ? -75 : -120}px;border-radius:50%;background:#253f8a;opacity:.5}
        .orb:after{content:'';position:absolute;inset:36px;border:1px solid #5d7eeb;border-radius:50%;opacity:.5}
        .copy{position:absolute;left:${small ? 30 : 82}px;top:${small ? 54 : 122}px;z-index:1}.eyebrow{font:12px Consolas,monospace;letter-spacing:2px;color:#9bb3ff;margin-bottom:24px}
        h1{font-size:${small ? 36 : 78}px;letter-spacing:-.045em;line-height:1.04;margin:0;font-weight:650}p{font-size:${small ? 15 : 27}px;line-height:1.5;color:#c0cde9;margin:${small ? 18 : 26}px 0 0}
        .mark{position:absolute;width:${small ? 165 : 360}px;height:${small ? 165 : 360}px;right:${small ? 20 : 108}px;top:${small ? 45 : 94}px;z-index:1}.mark svg{width:100%;height:100%;filter:drop-shadow(0 18px 20px #070e2655)}
        .rule{position:absolute;left:${small ? 30 : 82}px;right:${small ? 30 : 82}px;bottom:${small ? 27 : 51}px;height:1px;background:#30446c}.caption{position:absolute;left:82px;bottom:22px;font:12px Consolas,monospace;letter-spacing:1.5px;color:#a4b5da}
        </style></head><body><div class="orb"></div><div class="copy">${small ? '' : '<div class="eyebrow">A LOCAL WORKSPACE FOR YOUR CHAT</div>'}<h1>DeepDock<br>Harness</h1><p>Local tools for${small ? '<br>' : ' '}DeepSeek Chat.</p></div><div class="mark">${inlineMark}</div><div class="rule"></div>${small ? '' : '<div class="caption">FILES &nbsp; / &nbsp; SHELL &nbsp; / &nbsp; GIT &nbsp; / &nbsp; GITHUB</div>'}</body></html>`);
      await page.screenshot({ path: path.join(kit, 'promotional', name), type: 'jpeg', quality: 98 });
      console.log('Rendered ' + name);
    }
  }
} finally {
  await browser.close();
}

if (process.argv.includes('--icons')) process.exit(0);

const builtManifest = JSON.parse(await fs.readFile('.output/chrome-mv3/manifest.json', 'utf8'));
const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
if (builtManifest.version !== packageJson.version || builtManifest.name !== 'DeepDock Harness') throw new Error('Build the current extension before capturing screenshots.');

const bridge = new FixtureBridge();
bridge.toolData.set('dsh_read', { content: '1 | const greeting = "Hello";', sha256: 'example-original-hash' });
bridge.toolData.set('dsh_edit', { file: 'app.js', replaced: 1, sha256: 'example-updated-hash', change: {
  file: 'app.js', kind: 'edited', diff: '--- a/app.js\n+++ b/app.js\n@@ -1,1 +1,1 @@\n-const greeting = "Hello";\n+const greeting = "Welcome";', truncated: false,
} });
bridge.toolData.set('dsh_bash', { stdout: 'Greeting check passed.', stderr: '', exitCode: 0 });
await bridge.start();
const extensionPath = path.join(project, '.output/chrome-mv3');
const context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, args: ['--disable-extensions-except=' + extensionPath, '--load-extension=' + extensionPath] });
const sourceHtml = await fs.readFile('extension/test/fixtures/deepseek-dom.html', 'utf8');
const captures = [];

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate((settings) => chrome.storage.local.set(settings), { token: TOKEN, baseUrl: bridge.baseUrl });
  await context.route('https://chat.deepseek.com/**', (route) => route.fulfill({ contentType: 'text/html', body: sourceHtml }));
  const errors = [];
  async function chat(name) {
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('https://chat.deepseek.com/a/chat/s/store-' + name);
    await expect(page.locator('#dshpro-connection')).toHaveText('CONNECTED');
    // Constrain only the demo host canvas. The production panel keeps its own
    // styles and scrolling; long fixture transcripts cannot shift a capture.
    await page.addStyleTag({ content: 'html,body{margin:0;width:100%;height:100%;overflow:hidden}' });
    return page;
  }
  async function screenshot(page, name, number, title, copy, bullets, wide = false) {
    await page.evaluate(({ number, title, copy, bullets, wide, inlineMark }) => {
      document.querySelector('#store-presentation')?.remove();
      const frame = document.createElement('div');
      frame.id = 'store-presentation';
      frame.innerHTML = `<style>#store-presentation{position:fixed;inset:0;z-index:1000000;background:#101a20;color:#eff5f5;font-family:'Segoe UI',Arial,sans-serif;overflow:hidden}#store-presentation *{box-sizing:border-box}#store-presentation .halo{position:absolute;width:780px;height:780px;right:-250px;top:-210px;border-radius:50%;background:#1d344b;opacity:.65}#store-presentation .identity{position:absolute;left:56px;top:42px;display:flex;align-items:center;gap:12px;font-size:18px;font-weight:650;letter-spacing:-.5px}#store-presentation .identity svg{width:36px;height:36px}#store-presentation .story{position:absolute;left:60px;top:${wide ? 172 : 172}px;width:${wide ? 410 : 650}px}#store-presentation .kicker{font:11px Consolas,monospace;letter-spacing:2px;color:#9ab6ff;margin-bottom:24px}#store-presentation h1{font-size:${wide ? 51 : 66}px;font-weight:650;line-height:1.06;letter-spacing:-3px;margin:0 0 25px;max-width:${wide ? 405 : 610}px}#store-presentation .intro{font-size:${wide ? 17 : 20}px;line-height:1.65;color:#b4c5d2;max-width:${wide ? 365 : 560}px;margin:0}#store-presentation ul{list-style:none;padding:0;margin:31px 0 0}#store-presentation li{font-size:${wide ? 14 : 17}px;color:#dce8ed;margin-top:14px;display:flex;gap:12px;align-items:center}#store-presentation li:before{content:'✓';font-size:13px;color:#8eacff}#store-presentation .caption{position:absolute;left:60px;bottom:40px;font:10px Consolas,monospace;letter-spacing:.7px;color:#8dabbc;max-width:${wide ? 410 : 640}px;line-height:1.8}#store-presentation .number{position:absolute;left:60px;bottom:85px;font:11px Consolas,monospace;letter-spacing:2px;color:#6a829a}</style><div class="halo"></div><div class="identity">${inlineMark}<span>DeepDock Harness</span></div><div class="story"><div class="kicker">DEEPSEEK CHAT + YOUR WORKSPACE</div><h1>${title}</h1><p class="intro">${copy}</p><ul>${bullets.map((line) => '<li>' + line + '</li>').join('')}</ul></div><div class="number">${number} / 05</div><div class="caption">Actual extension interface · Local demo with example data.<br>Independent project. Not affiliated with DeepSeek.</div>`;
      document.body.append(frame);
    }, { number, title, copy, bullets, wide, inlineMark });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(100);
    const panelBounds = await page.locator('#dshpro-panel').boundingBox();
    if (panelBounds.x < 0 || panelBounds.x + panelBounds.width > 1280 || panelBounds.y < 0 || panelBounds.y + panelBounds.height > 800) throw new Error('Panel would be clipped: ' + name + ' ' + JSON.stringify(panelBounds));
    const destination = path.join(kit, 'screenshots', name);
    await page.screenshot({ path: destination, type: 'jpeg', quality: 98 });
    await page.locator('#store-presentation').evaluate((frame) => frame.remove());
    captures.push({ file: 'screenshots/' + name, width: 1280, height: 800, source: 'Real extension running against the local DOM and tool-result fixture; example data.' });
    console.log('Captured ' + name);
  }

  const taskPage = await chat('local-tools');
  await enable(taskPage);
  await queue(taskPage, [
    tool('dsh_read', { path: 'app.js' }, 'Reading the greeting before editing it.'),
    tool('dsh_edit', { path: 'app.js', oldText: 'Hello', newText: 'Welcome' }, 'Changing the greeting to Welcome.'),
    tool('dsh_bash', { command: 'node check-greeting.js' }, 'Checking the updated greeting.'),
    'DSH:DONE:Changed the greeting to Welcome. The greeting check passed.',
  ]);
  await submit(taskPage, 'Change the greeting to Welcome and run its check.');
  await complete(taskPage, worker, 30000);
  await screenshot(taskPage, '01-local-workspace.jpg', '01', 'Give your chat<br>a local workspace.', 'Turn a coding conversation into focused work on your project.', ['Read, search, write, and edit files', 'Run checks and inspect tool results', 'Keep progress beside the conversation']);

  await taskPage.locator('#dshpro-history-size').click();
  await taskPage.locator('#dshpro-file-changes > summary').click();
  await taskPage.locator('#dshpro-file-changes button').first().click();
  await expect(taskPage.locator('.dshpro-file-diff[open]')).toBeVisible();
  await screenshot(taskPage, '02-review-file-diffs.jpg', '02', 'See the change.<br>Check the result.', 'Follow each tool step, then inspect the recorded file diff.', ['Readable explanations for each step', 'Before-and-after file changes', 'Command output when you need it'], true);
  await taskPage.locator('#dshpro-history-size').click();

  await taskPage.getByLabel('Permissions', { exact: true }).selectOption('always');
  await queue(taskPage, [tool('dsh_read', { path: 'README.md' }, 'Reading the README before proposing a change.'), 'DSH:DONE:Read the README. No files changed.']);
  await submit(taskPage, 'Read the README before proposing a change.');
  await expect(taskPage.getByRole('alertdialog')).toBeVisible();
  await taskPage.locator('#dshpro-confirm').scrollIntoViewIfNeeded();
  await screenshot(taskPage, '03-permission-controls.jpg', '03', 'You decide<br>what runs.', 'Choose how much approval your workflow needs. Your saved mode controls the agent.', ['Ask before every tool', 'Approve important commands', 'Allow once, deny, or stop the task']);
  await taskPage.getByRole('button', { name: 'Allow once', exact: true }).click();
  await complete(taskPage, worker);
  await taskPage.getByLabel('Permissions', { exact: true }).selectOption('important');

  const resumePage = await chat('resume');
  await enable(resumePage);
  await queue(resumePage, [tool('dsh_read', { path: 'README.md' }, 'Reading the project overview.'), { hold: true, partial: 'Working on the next step...' }]);
  await submit(resumePage, 'Inspect this project and suggest a focused next step.');
  await resumePage.waitForFunction(() => window.fixture.sent.length === 3);
  await resumePage.reload();
  await expect(resumePage.locator('#dshpro-resume')).toBeVisible();
  await screenshot(resumePage, '04-resume-work.jpg', '04', 'Return to<br>unfinished work.', 'Saved conversation checkpoints keep the task available after a reload.', ['Resume is an explicit choice', 'Review recorded tool results', 'Uncertain requests pause for review']);

  const settingsPage = await chat('settings');
  await settingsPage.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settingsPage.getByLabel('Bridge token', { exact: true })).toHaveValue('');
  await screenshot(settingsPage, '05-local-bridge-setup.jpg', '05', 'Pair once.<br>Work locally.', 'Connect the extension to your separately installed bridge on this device.', ['Choose an allowed project folder', 'Paste the local pairing token', 'Test the connection and enable the agent']);

  await taskPage.setViewportSize({ width: 1440, height: 1180 });
  await taskPage.locator('#dshpro-panel').evaluate((panel) => { panel.querySelector('.dshpro-body').scrollTop = 0; });
  await taskPage.locator('#dshpro-panel').screenshot({ path: 'docs/assets/workspace-panel.png' });
  if (errors.length) throw new Error('Capture page errors: ' + errors.join('; '));
  await fs.writeFile(path.join(kit, 'screenshots/capture-manifest.json'), JSON.stringify({ extensionVersion: builtManifest.version, captureMethod: 'Playwright loading the actual built MV3 extension; no production panel styles or labels modified. The branded backdrop labels the local fixture and example data.', screenshots: captures }, null, 2) + '\n');
} finally {
  await context.close();
  await bridge.stop();
}
