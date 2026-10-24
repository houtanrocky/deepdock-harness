import { normalizeBridgeUrl } from './contracts.ts';

/** Register the MV3 service worker synchronously; state is restored from storage. */
export function startBackground(browser, dependencies = {}) {
  const { fetch = globalThis.fetch, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout } = dependencies;
  // DeepDock Harness - background.js (MV3 Service Worker)
  // 职责：
  //  1. 代理 content script -> 桥接服务的所有 HTTP 请求（统一附加 Bearer token，规避页面 CORS）
  //  2. handoff runId 轮询兜底：browser.alarms 定期唤醒（content 页面在前台时自己也会更快轮询）
  //  3. runId 存 browser.storage.session，Service Worker 休眠后恢复仍可续查

  const DEFAULT_BASE = 'http://127.0.0.1:8765';

  // Serialize transcript writes across tabs and service-worker requests. Each URL
  // owns an array plus its loop checkpoint; revisions prevent stale overwrites.
  let persistenceQueue = Promise.resolve();
  function conversationRequest(msg, sender) {
    const operation = persistenceQueue.then(async () => {
      const url = new URL(msg.url);
      if (url.origin !== 'https://chat.deepseek.com') throw new Error('Invalid conversation URL');
      const key = 'dshpro:conversation:' + url.origin + url.pathname;
      const stored = (await browser.storage.local.get(key))[key] || { conversationHistory: [], iterationCount: 0, revision: 0, inProgress: false };
      if (msg.type === 'conversationLoad') return { ok: true, data: stored };
      const session = await browser.storage.session.get({ agentLeases: {} });
      const leases = session.agentLeases;
      const lease = leases[key];
      const owned = lease && lease.tabId === sender.tab?.id && lease.runId === msg.runId;
      if (msg.type === 'conversationClaim') {
        if (lease && lease.expires > Date.now() && !owned && lease.tabId !== sender.tab?.id) throw new Error('This conversation already has an active agent in another tab.');
        leases[key] = { tabId: sender.tab?.id, runId: msg.runId, expires: Date.now() + 45000 };
      } else if (msg.type === 'conversationRelease') {
        if (owned) delete leases[key];
      } else {
        if (!owned || lease.expires < Date.now()) throw new Error('Agent ownership expired. Stop and resume the task.');
        leases[key].expires = Date.now() + 45000;
        if (msg.type === 'conversationMove') {
          const destination = new URL(msg.destination);
          if (destination.origin !== url.origin) throw new Error('Invalid conversation destination');
          const target = 'dshpro:conversation:' + destination.origin + destination.pathname;
          const existing = (await browser.storage.local.get(target))[target];
          if (existing || (leases[target] && leases[target].expires > Date.now())) throw new Error('The destination conversation already has saved work.');
          if (msg.data.revision !== stored.revision) throw new Error('Conversation changed before navigation.');
          const next = { ...msg.data, revision: stored.revision + 1 };
          await browser.storage.local.set({ [target]: next });
          await browser.storage.local.remove(key);
          leases[target] = leases[key]; delete leases[key];
          await browser.storage.session.set({ agentLeases: leases });
          return { ok: true, revision: next.revision };
        }
        if (msg.type === 'conversationSave') {
          if (msg.data.revision !== stored.revision) throw new Error('Conversation changed in another tab. Reload before resuming.');
          if (!Array.isArray(msg.data.conversationHistory)) throw new Error('Invalid conversation history');
          const next = { ...msg.data, revision: stored.revision + 1 };
          await browser.storage.local.set({ [key]: next });
          await browser.storage.session.set({ agentLeases: leases });
          return { ok: true, revision: next.revision };
        }
      }
      await browser.storage.session.set({ agentLeases: leases });
      return { ok: true };
    });
    persistenceQueue = operation.catch(() => {});
    return operation;
  }

  async function getCfg() {
    const d = await browser.storage.local.get(['token', 'baseUrl']);
    return { token: d.token || '', baseUrl: normalizeBridgeUrl(d.baseUrl || DEFAULT_BASE) };
  }

  async function bridgeFetch({ method = 'GET', path = '/', body = null }) {
    const { token, baseUrl } = await getCfg();
    if (method === 'POST' && path === '/tool' && body) {
      // Permission policy comes from the user's saved selector, not model args.
      const settings = await browser.storage.local.get(['permissionMode']);
      body = { ...body, permissionMode: ['full', 'important', 'always'].includes(settings.permissionMode) ? settings.permissionMode : 'important' };
    }
    const target = baseUrl.replace(/\/$/, '') + path;
    // Only reads can be retried: a dropped POST response may follow a successful
    // write or command. A new request could execute that operation twice.
    const readOnly = method === 'GET' || (method === 'POST' && path === '/instructions');
    const attempts = readOnly ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = readOnly ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), 5000) : null;
      try {
        const res = await fetch(target, {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: 'Bearer ' + token } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          ...(controller ? { signal: controller.signal } : {}),
        });
        let json = null;
        try {
          json = await res.json();
        } catch (error) {
          // A truncated response is also an uncertain outcome for a POST.
          if (!(error instanceof SyntaxError)) throw error;
        }
        return { ok: res.ok, status: res.status, json };
      } catch (error) {
        if (attempt === attempts - 1) {
          const detail = controller?.signal.aborted ? 'Timed out after 5 seconds' : String(error?.message || error);
          return {
            ok: false, status: 0, code: 'E_BRIDGE_UNREACHABLE',
            error: `Local bridge request failed (${method} ${target}): ${detail}. Check scripts/start-deepdock.cmd and the extension's bridge host permission, then reconnect and resume.` +
              (readOnly ? '' : ' The operation may have executed; inspect the workspace before retrying it.'),
          };
        }
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }

  // ---- handoff 轮询兜底 ----
  async function trackRun(runId) {
    const d = await browser.storage.session.get({ runs: [] });
    const runs = d.runs.filter((r) => r !== runId);
    runs.push(runId);
    await browser.storage.session.set({ runs });
    await browser.alarms.create('dshpro-poll', { periodInMinutes: 0.5 });
  }

  async function untrackRun(runId) {
    const d = await browser.storage.session.get({ runs: [] });
    await browser.storage.session.set({ runs: d.runs.filter((r) => r !== runId) });
    const left = (await browser.storage.session.get({ runs: [] })).runs;
    if (left.length === 0) await browser.alarms.clear('dshpro-poll');
  }

  async function pollTrackedRuns() {
    const d = await browser.storage.session.get({ runs: [] });
    const finished = [];
    for (const runId of d.runs) {
      const r = await bridgeFetch({ method: 'GET', path: '/handoff/' + runId });
      const status = r.json && r.json.run && r.json.run.status;
      if (status && status !== 'running') {
        finished.push({ runId, status });
        await untrackRun(runId);
        // 缓存最终状态，扩展醒来后可读取
        await browser.storage.session.set({ ['last:' + runId]: r.json.run });
      }
    }
    return finished;
  }

  const onAlarm = (alarm) => {
    if (alarm.name === 'dshpro-poll') pollTrackedRuns().catch((error) => console.error('Handoff alarm polling failed:', error));
  };

  // ---- 消息路由 ----
  const onMessage = (msg, sender, sendResponse) => {
    (async () => {
      switch (msg && msg.type) {
        case 'conversationLoad':
        case 'conversationClaim':
        case 'conversationSave':
        case 'conversationHeartbeat':
        case 'conversationRelease':
        case 'conversationMove':
          sendResponse(await conversationRequest(msg, sender));
          break;
        case 'bridge':
          sendResponse(await bridgeFetch(msg));
          break;
        case 'trackHandoff':
          await trackRun(msg.runId);
          sendResponse({ ok: true });
          break;
        case 'handoffStatus': {
          const r = await bridgeFetch({ method: 'GET', path: '/handoff/' + msg.runId });
          const status = r.json && r.json.run && r.json.run.status;
          if (status && status !== 'running') await untrackRun(msg.runId);
          sendResponse(r);
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message type' });
      }
    })().catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true; // 异步 sendResponse
  };

  browser.alarms.onAlarm.addListener(onAlarm);
  browser.runtime.onMessage.addListener(onMessage);
  return {
    bridgeFetch, conversationRequest, pollTrackedRuns,
    dispose() {
      browser.alarms.onAlarm.removeListener?.(onAlarm);
      browser.runtime.onMessage.removeListener?.(onMessage);
    },
  };
}
