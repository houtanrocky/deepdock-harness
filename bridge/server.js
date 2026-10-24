'use strict';
// DeepDock Harness - server.js
// 本地桥接服务：HTTP 路由 + Bearer token 鉴权 + 限流 + 审计。
// 仅绑定 127.0.0.1。零 npm 依赖。启动：node server.js（需先运行 scripts/pair.ps1 生成 token）。
// 预留 /mcp 路由分支：将来可在同一 handler 层挂 streamable-HTTP MCP 端点，
// tools/list -> GET /tools、tools/call -> POST /tool，供 ChatGPT Connector / Claude 直连复用工具层。

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { loadConfig, ToolError, redact, resolveWorkspace } = require('./guard');
const { TOOL_DEFS, runTool } = require('./tools');
const { HandoffManager, dshProbe } = require('./handoff');
const BUILD_ID = require('./build').bridgeBuildId();

const BRIDGE_DIR = __dirname;
const CONFIG_DIR = path.resolve(process.env.DEEPDOCK_CONFIG_DIR || BRIDGE_DIR);
const AUDIT_FILE = path.join(CONFIG_DIR, 'audit.jsonl');

let config;
try {
  config = loadConfig(CONFIG_DIR);
} catch (err) {
  console.error('[DeepDock Harness] config load failed:', err.message);
  process.exit(1);
}
if (!config.token || String(config.token).length < 32) {
  console.error('[DeepDock Harness] config.json token is empty. Run scripts\\pair.ps1 first.');
  process.exit(1);
}

const handoff = new HandoffManager(config);
const pendingConfirms = new Map(); // confirmToken -> {exp, tool, args, workspace}
let activeTools = 0;
let shuttingDown = false;

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function audit(entry) {
  try {
    const clean = {};
    for (const [k, v] of Object.entries(entry)) {
      clean[k] = typeof v === 'string' ? redact(v).slice(0, 300) : v;
    }
    fs.appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...clean }) + '\n', 'utf8');
  } catch {}
}

// 限流：60 req/min（仅 127.0.0.1 可达，防御性设计）
const rateBuckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const win = now - 60000;
  let arr = rateBuckets.get(ip);
  if (!arr) {
    arr = [];
    rateBuckets.set(ip, arr);
  }
  while (arr.length && arr[0] < win) arr.shift();
  if (arr.length >= 60) return true;
  arr.push(now);
  return false;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': 'http://127.0.0.1:8765',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

const HTTP_STATUS = {
  E_UNAUTHORIZED: 401,
  E_TOOL_NOT_FOUND: 404,
  E_ARGS_INVALID: 400,
  E_ROOT_NOT_ALLOWED: 403,
  E_PATH_ESCAPE: 403,
  E_SYMLINK_ESCAPE: 403,
  E_FORBIDDEN_PATH: 403,
  E_BINARY_FILE: 415,
  E_BASH_BLOCKED: 403,
  E_NEEDS_CONFIRM: 403,
  E_BUSY: 409,
  E_TIMEOUT: 408,
  E_COMMAND_FAILED: 422,
  E_MISSING_CREDENTIAL: 503,
  E_INTERNAL: 500,
};

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new ToolError('E_ARGS_INVALID', 'Request body exceeds the 10MB limit'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function authOk(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return timingSafeEqual(m[1], config.token);
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
async function handle(req, res, pathname, body) {
  switch (pathname) {
    case '/health': {
      const probe = dshProbe(config);
      const readiness = handoff.availability?.(probe) || {};
      return {
        ok: true,
        name: 'dsh-pro',
        version: '0.1.0',
        buildId: BUILD_ID,
        toolCount: TOOL_DEFS.filter((tool) => tool.name !== 'dsh_handoff' || readiness.available !== false).length,
        activeTools,
        activeHandoff: handoff.current?.runId || null,
        allowedRoots: config.allowedRoots,
        dsh: { binFound: probe.binFound, bin: probe.bin, nodeSource: probe.node ? probe.node.source : null, ...readiness },
      };
    }
    case '/tools': {
      const readiness = handoff.availability?.();
      return { ok: true, tools: TOOL_DEFS.filter((tool) => tool.name !== 'dsh_handoff' || readiness?.available !== false) };
    }
    case '/tool': {
      if (shuttingDown) throw new ToolError('E_BUSY', 'The bridge is restarting. Reconnect before starting more work.');
      const { tool, args, workspace, confirmToken } = body || {};
      const permissionMode = ['full', 'important', 'always'].includes(body?.permissionMode) ? body.permissionMode : 'important';
      if (!tool || typeof tool !== 'string') throw new ToolError('E_ARGS_INVALID', 'Missing tool field');
      const started = Date.now();
      const call = async (confirmed) => {
        const ctx = { config, workspace, confirmed, permissionMode };
        activeTools++;
        try { return await runTool(tool, args, ctx, handoff); }
        finally { activeTools--; }
      };
      let data;
      try {
        data = await call(false);
      } catch (err) {
        if (err instanceof ToolError && err.code === 'E_NEEDS_CONFIRM') {
          if (confirmToken && pendingConfirms.has(confirmToken)) {
            const pending = pendingConfirms.get(confirmToken);
            pendingConfirms.delete(confirmToken);
            if (pending.exp < Date.now()) throw new ToolError('E_NEEDS_CONFIRM', 'Confirmation token expired; submit the request again');
            if (pending.tool !== tool || pending.permissionMode !== permissionMode || JSON.stringify(pending.args || {}) !== JSON.stringify(args || {}) || resolveWorkspace(config, pending.workspace) !== resolveWorkspace(config, workspace)) {
              throw new ToolError('E_NEEDS_CONFIRM', 'Confirmation token does not match this tool, arguments, or workspace');
            }
            data = await call(true);
          } else {
            const token = crypto.randomBytes(16).toString('hex');
            pendingConfirms.set(token, { exp: Date.now() + 10 * 60 * 1000, tool, args, workspace, permissionMode });
            // 清理过期项
            for (const [k, v] of pendingConfirms) if (v.exp < Date.now()) pendingConfirms.delete(k);
            err.extra = { ...(err.extra || {}), confirmToken: token };
            throw err;
          }
        } else {
          throw err;
        }
      }
      audit({ op: 'tool', tool, workspace: workspace || config.allowedRoots[0], ms: Date.now() - started, ok: true });
      // 超 24KB 的结果落盘 .dsh-pro/outputs/，模型可用 dsh_read 分段读取
      let payload = data;
      const dataStr = JSON.stringify(data);
      if (dataStr.length > 24576) {
        const root = resolveWorkspace(config, workspace);
        const outsDir = path.join(root, '.dsh-pro', 'outputs');
        fs.mkdirSync(outsDir, { recursive: true });
        const name = `${Date.now()}-${String(tool).replace(/[^a-z0-9_-]/gi, '_')}.json`;
        fs.writeFileSync(path.join(outsDir, name), JSON.stringify(data, null, 2), 'utf8');
        // Keep the complete structured result, plus a line-readable text copy.
        // Escaped stdout in a one-line JSON string cannot be paged by line number.
        const textField = ['stdout', 'content', 'tree', 'diff'].find((key) => typeof data?.[key] === 'string' && data[key].length > 0);
        const readName = textField ? name.replace(/\.json$/, `.${textField}.txt`) : name;
        if (textField) fs.writeFileSync(path.join(outsDir, readName), data[textField], 'utf8');
        const resultMeta = Object.fromEntries(['exitCode', 'shell', 'truncated', 'file', 'sha256', 'logFile'].filter((key) => ['string', 'number', 'boolean'].includes(typeof data?.[key])).map((key) => [key, data[key]]));
        payload = {
          ...resultMeta,
          preview: dataStr.slice(0, 12000),
          fullOutputFile: `.dsh-pro/outputs/${name}`,
          fullOutputWorkspace: root,
          ...(textField ? { textOutputFile: `.dsh-pro/outputs/${readName}` } : {}),
          readWith: { tool: 'dsh_read', args: { workspace: root, path: `.dsh-pro/outputs/${readName}`, offset: 1, limit: 80 } },
          hint: 'Full output is saved under the bridge workspace, regardless of cd inside the command. Use readWith exactly; do not prepend ../. textOutputFile contains plain text for line-range reads; fullOutputFile preserves the complete JSON result.',
        };
      }
      return { ok: true, data: payload, meta: { durationMs: Date.now() - started } };
    }
    case '/handoff': {
      if (shuttingDown) throw new ToolError('E_BUSY', 'The bridge is restarting. Reconnect before starting more work.');
      if (req.method !== 'POST') throw new ToolError('E_ARGS_INVALID', 'Only POST is supported');
      const { planText, workspace, taskNote, timeoutMs } = body || {};
      const started = Date.now();
      const r = handoff.start({ workspace, planText, taskNote, timeoutMs });
      audit({ op: 'handoff-start', workspace: workspace || config.allowedRoots[0], runId: r.runId, planMs: Date.now() - started });
      return { ok: true, ...r };
    }
    default:
      // /handoff/:runId 与 /handoff/:runId/cancel
      const m = pathname.match(/^\/handoff\/([A-Za-z0-9-]+)(\/cancel)?$/);
      if (m) {
        const runId = m[1];
        if (req.method === 'POST' && m[2]) {
          return { ok: true, ...handoff.cancel(runId) };
        }
        if (req.method === 'GET') {
          const run = handoff.get(runId);
          if (!run) throw new ToolError('E_TOOL_NOT_FOUND', `Handoff not found: ${runId}`);
          return { ok: true, run };
        }
      }
      if (pathname === '/mcp') {
        throw new ToolError('E_TOOL_NOT_FOUND', 'The MCP endpoint is reserved and not implemented yet (see server.js comments)');
      }
      if (pathname === '/shutdown') {
        if (req.method !== 'POST') throw new ToolError('E_ARGS_INVALID', 'Only POST is supported');
        if (activeTools || handoff.current) throw new ToolError('E_BUSY', 'The bridge is executing work. Stop or finish the active task before restarting.');
        shuttingDown = true;
        setTimeout(() => process.exit(0), 300);
        return { ok: true, bye: true };
      }
      throw new ToolError('E_TOOL_NOT_FOUND', `Unknown path: ${pathname}`);
  }
}

const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || '';
  const u = new URL(req.url, 'http://127.0.0.1');
  const pathname = u.pathname;
  const started = Date.now();

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': 'http://127.0.0.1:8765',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    res.end();
    return;
  }

  try {
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      throw new ToolError('E_UNAUTHORIZED', 'Only local access is allowed');
    }
    if (rateLimited(ip)) {
      throw new ToolError('E_BUSY', 'Too many requests (60/min)');
    }
    if (!authOk(req)) {
      throw new ToolError('E_UNAUTHORIZED', 'Missing or incorrect Bearer token. Run scripts/pair.ps1 to pair first.');
    }
    let body = null;
    if (req.method === 'POST') {
      const raw = await readBody(req, 10 * 1024 * 1024);
      if (raw.trim()) {
        try {
          body = JSON.parse(raw);
        } catch {
          throw new ToolError('E_ARGS_INVALID', 'Request body is not valid JSON');
        }
      }
    }
    const result = await handle(req, res, pathname, body);
    audit({ op: 'http', method: req.method, path: pathname, ms: Date.now() - started, ok: true });
    sendJson(res, 200, result);
  } catch (err) {
    const isTool = err instanceof ToolError;
    const code = isTool ? err.code : 'E_INTERNAL';
    const status = HTTP_STATUS[code] || 500;
    audit({ op: 'http', method: req.method, path: pathname, ms: Date.now() - started, ok: false, code, msg: String(err && err.message) });
    sendJson(res, status, { ok: false, error: { code, message: String(err && err.message), ...(isTool && err.extra ? { extra: err.extra } : {}) } });
  }
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`[DeepDock Harness] bridge listening on http://127.0.0.1:${config.port}`);
  console.log(`[DeepDock Harness] allowedRoots: ${config.allowedRoots.join(' ; ')}`);
  const probe = dshProbe(config);
  console.log(`[DeepDock Harness] dsh runtime: ${probe.binFound ? 'found' : 'NOT FOUND'} (${probe.bin || '-'})`);
});

process.on('uncaughtException', (err) => {
  console.error('[DeepDock Harness] uncaught:', err && err.stack);
});
process.on('unhandledRejection', (err) => {
  console.error('[DeepDock Harness] unhandledRejection:', String(err));
});
