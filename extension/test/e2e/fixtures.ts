import { test as base, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { TOOL_DEFS } from '../../../bridge/tools.js';

export const TOKEN = 'local-browser-test-token';
export const tool = (name: string, args: Record<string, unknown> = {}, summary?: string) => `⟦DSH⟧${JSON.stringify({ tool: name, args, ...(summary ? { summary } : {}) })}⟦/DSH⟧`;

interface BridgeCall {
  tool: string;
  args: Record<string, any>;
  permissionMode: string;
  confirmToken?: string;
}

export class FixtureBridge {
  calls: BridgeCall[] = [];
  applied: BridgeCall[] = [];
  confirmTools = new Set<string>();
  dropTools = new Set<string>();
  toolData = new Map<string, Record<string, unknown>>();
  toolErrors = new Map<string, { code: string; message: string; extra?: Record<string, unknown> }>();
  toolDelayMs = 0;
  requests: string[] = [];
  handoffStatus = 'done';
  cancelled = false;
  baseUrl = '';
  server = createServer(async (request, response) => {
    this.requests.push(`${request.method} ${request.url}`);
    response.setHeader('Content-Type', 'application/json');
    const send = (data: unknown, status = 200) => { response.writeHead(status); response.end(JSON.stringify(data)); };
    if (request.headers.authorization !== `Bearer ${TOKEN}`) return send({ ok: false, error: { message: 'Invalid bridge token' } }, 401);
    if (request.url === '/health') return send({ ok: true, name: 'dsh-pro', allowedRoots: ['C:/fixture', 'C:/second-workspace'], dsh: { binFound: true }, buildId: 'fixture-browser-build' });
    if (request.url === '/tools') return send({ ok: true, tools: TOOL_DEFS });
    if (request.url === '/tool') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      this.calls.push(body);
      if (this.confirmTools.has(body.tool) && !body.confirmToken) return send({ ok: false, error: { code: 'E_NEEDS_CONFIRM', message: 'Confirm sensitive operation', extra: { confirmToken: 'fixture-confirm' } } }, 403);
      const error = this.toolErrors.get(body.args.path || body.args.command || body.tool) || this.toolErrors.get(body.tool);
      if (error) return send({ ok: false, error }, error.code === 'E_TIMEOUT' ? 408 : 422);
      this.applied.push(body);
      if (this.dropTools.has(body.tool)) { request.socket.destroy(); return; }
      if (this.toolDelayMs) await new Promise((resolve) => setTimeout(resolve, this.toolDelayMs));
      return send({ ok: true, data: this.toolData.get(body.tool) || (body.tool === 'dsh_handoff' ? { runId: 'fixture-run', timeoutMs: 30000 } : { content: 'tool result', sha256: 'fixture-hash' }) });
    }
    if (request.url?.endsWith('/cancel')) { this.cancelled = true; this.handoffStatus = 'cancelled'; return send({ ok: true, status: 'cancelled' }); }
    if (request.url === '/handoff/fixture-run') return send({ ok: true, run: { runId: 'fixture-run', status: this.handoffStatus, exitCode: 0, stdout: 'Finished', note: '' } });
    send({ ok: false }, 404);
  });

  async start() {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async stop() {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }
}

type Fixtures = {
  bridge: FixtureBridge;
  extension: BrowserContext;
  worker: Worker;
  chat: Page;
};

export const test = base.extend<Fixtures>({
  bridge: async ({}, use) => {
    const bridge = new FixtureBridge();
    await bridge.start();
    try { await use(bridge); } finally { await bridge.stop(); }
  },
  extension: async ({ bridge }, use) => {
    const extensionPath = fileURLToPath(new URL('../../../.output/chrome-mv3/', import.meta.url));
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1440, height: 1100 },
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    try {
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
      await worker.evaluate((settings) => chrome.storage.local.set(settings), { token: TOKEN, baseUrl: bridge.baseUrl });
      const html = await readFile(new URL('../fixtures/deepseek-dom.html', import.meta.url), 'utf8');
      const semanticHtml = await readFile(new URL('../fixtures/semantic-chat.html', import.meta.url), 'utf8');
      await context.route('https://chat.deepseek.com/**', (route) => route.fulfill({
        contentType: 'text/html', body: route.request().url().includes('/semantic-') ? semanticHtml : html,
      }));
      await use(context);
    } finally { await context.close(); }
  },
  worker: async ({ extension }, use) => { await use(extension.serviceWorkers()[0]); },
  chat: async ({ extension }, use, info) => {
    const page = await extension.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`https://chat.deepseek.com/a/chat/s/${info.testId.replace(/[^a-z0-9]/gi, '')}`);
    await expect(page.locator('#dshpro-connection')).toHaveText('CONNECTED');
    await use(page);
    expect(errors, 'No uncaught page errors').toEqual([]);
  },
});

export { expect };

export async function queue(page: Page, responses: unknown[]) {
  await page.evaluate((values) => (window as any).fixture.responses.push(...values), responses);
}

export async function enable(page: Page) {
  await queue(page, ['Protocol understood']);
  await page.locator('#dshpro-enable').click();
  await expect(page.locator('#dshpro-phase')).toHaveText('Ready');
}

export async function submit(page: Page, task = 'Read a file and summarize') {
  await page.locator('textarea').first().fill(task);
  await page.locator('textarea').first().press('Enter');
}

export async function checkpoint(page: Page, worker: Worker) {
  const key = 'dshpro:conversation:' + new URL(page.url()).origin + new URL(page.url()).pathname;
  return worker.evaluate(async (key) => (await chrome.storage.local.get(key))[key], key);
}

export async function complete(page: Page, worker: Worker, timeout = 15_000) {
  await expect.poll(async () => (await checkpoint(page, worker))?.stage, { timeout }).toBe('completed');
  await expect(page.locator('#dshpro-stop')).toBeDisabled();
}
