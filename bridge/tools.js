'use strict';
// DeepDock Harness - tools.js
// Core tools plus modular Git/GitHub tools; metadata and execution share a registry.
// 所有路径均为 workspace 相对路径，经 guard.validatePath 校验。
// 每次调用经 runTool 统一写执行日志 .dsh-pro/logs/execution-log.jsonl（参照 CodexPro 模式）。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const {
  ToolError,
  resolveWorkspace,
  validatePath,
  looksBinaryByExt,
  sniffBinary,
  redact,
} = require('./guard');
const { createToolRegistry } = require('./tool-registry');
const { snapshotFile, fileChange } = require('./file-changes');

const READ_MAX_BYTES = 512 * 1024;
const RANGE_SCAN_MAX_BYTES = 2 * 1024 * 1024; // 带 offset/limit 时允许的扫描上限（参照 CodexPro textScanByteLimit）
const BASH_OUT_MAX = 64 * 1024;
const TREE_MAX_ENTRIES = 2000;
const SEARCH_MAX_FILES = 5000;
const DIFF_MAX_BYTES_DEFAULT = 48000;
const LOG_REL_PATH = '.dsh-pro/logs/execution-log.jsonl';
const SHELL = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
const SHELL_DESCRIPTION = process.platform === 'win32'
  ? 'Windows cmd.exe (not Bash or PowerShell): use dir, type, and findstr; invoke powershell.exe explicitly for PowerShell commands. Percent-delimited text can expand as environment variables, including in quoted URLs'
  : '/bin/sh (POSIX shell)';

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// CodexPro 风格行号：右侧对齐，" 12 | code"，方便模型精确引用行号
function withLineNumbers(lines, startLine) {
  const width = String(startLine + lines.length - 1).length;
  return lines.map((line, idx) => `${String(startLine + idx).padStart(width, ' ')} | ${line}`).join('\n');
}

// ---------------------------------------------------------------------------
// 工具元数据（GET /tools 的数据源；扩展据此生成协议消息，防两端清单漂移）
// ---------------------------------------------------------------------------
const CORE_DEFS = [
  { name: 'dsh_tree', description: 'List the directory tree (excluding node_modules/.git)', params: { path: 'string?', depth: 'int? default 3' } },
  { name: 'dsh_read', description: 'Read part of a text file with 1-based line numbers; returns the source file sha256 for edit verification. For saved command-output JSON, jsonField:stdout reads the unescaped report in line ranges', params: { path: 'string', offset: 'int? default 1', limit: 'int? default 200', jsonField: 'string? Read a string field from JSON: stdout, stderr, content, tree, or diff; offsets apply to the selected field' } },
  { name: 'dsh_write', description: 'Write a file, replacing its entire contents and creating parent directories. For long files send small chunks: write the first, then append with the preceding result hash; read back to verify', params: { path: 'string', content: 'string', append: 'bool? default false; append to an existing file; requires expectedSha256 to prevent duplicate chunks on retry', expectedSha256: 'string? Current file hash from dsh_read or the preceding write; required for append' } },
  { name: 'dsh_edit', description: 'Replace an exact, unique text occurrence in a file', params: { path: 'string', oldText: 'string', newText: 'string', expectedSha256: 'string? sha256 returned by dsh_read; reject edits if the file has changed' } },
  { name: 'dsh_search', description: 'Search file contents using plain text or a regular expression', params: { query: 'string', path: 'string?', regex: 'bool?', caseSensitive: 'bool?', maxResults: 'int? default 50' } },
  { name: 'dsh_bash', description: `Run a command using ${SHELL_DESCRIPTION}. Full access permits that shell's pipes, chains, and redirection; other modes apply command checks. Nonzero exits return E_COMMAND_FAILED with captured output`, params: { command: 'string', timeoutMs: 'int? default 20000' } },
  { name: 'dsh_git_status', description: 'Read-only git status in porcelain format', params: { path: 'string?' } },
  { name: 'dsh_git_diff', description: 'Read-only git diff; large results are saved to disk', params: { path: 'string?', staged: 'bool?', maxBytes: 'int? default 48000' } },
  { name: 'dsh_handoff', description: 'Run a local agent (dsh headless) for a self-contained plan with acceptance criteria. Requires separate provider credentials in the local agent credentials service or launch environment (DEEPSEEK_API_KEY for deepseek-official); executable presence does not verify credentials. E_MISSING_CREDENTIAL is not retryable until configured. Use direct tools if unavailable. End your response immediately after this call', params: { planText: 'string Complete plan text', workspace: 'string?', taskNote: 'string? Task title for log filenames', timeoutMs: 'int? default 300000, maximum 1800000' } },
  { name: 'dsh_log', description: 'Read the end of the execution log (.dsh-pro/logs/execution-log.jsonl); every tool call is logged automatically', params: { lines: 'int? default 100, maximum 1000' } },
];

// ---------------------------------------------------------------------------
// bash 安全层：白名单前缀 + 无条件黑名单 + 元字符封禁
// ---------------------------------------------------------------------------
const BASH_META_CHARS = /[|&<>;`\n\r$]/;

const BASH_BLACKLIST_RE = new RegExp(
  [
    '\\b(rm|del|rd|rmdir|mv|move|cp|copy|dd|shutdown|taskkill|tskill|reg|netsh|setx|sudo',
    'curl|wget|powershell|pwsh|iwr|irm|invoke-expression|invoke-webrequest|ssh|scp|sftp|ftp',
    'certutil|bitsadmin|mshta|rundll32|regsvr32|schtasks|at|sc)\\b',
    '\\bformat\\s+[a-z]:',
    '\\bnet\\s+(use|user|localgroup|share|stop|start|session|file|time|accounts)\\b',
    '\\bgit\\s+(push|commit|checkout|switch|reset|clean|rebase|merge|stash|restore|rm|mv|apply|cherry-pick|revert|tag|am|filter-branch|bisect)\\b',
  ].join('|'),
  'i'
);

function checkBashCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new ToolError('E_ARGS_INVALID', 'command must be a non-empty string');
  }
  if (command.length > 2000) throw new ToolError('E_ARGS_INVALID', 'Command is too long (over 2000 characters)');
  if (BASH_META_CHARS.test(command)) {
    throw new ToolError('E_BASH_BLOCKED', 'Command contains forbidden metacharacters (| & > < ; ` $ or newlines)');
  }
  if (BASH_BLACKLIST_RE.test(command)) {
    throw new ToolError('E_BASH_BLOCKED', `Command is blocked: ${command.slice(0, 120)}`);
  }
  const trimmed = command.trim().replace(/\s+/g, ' ');
  const lower = trimmed.toLowerCase();
  const tokens = lower.split(' ');
  const head = tokens[0];
  const second = tokens[1] || '';

  const plainHeads = new Set(['pwd', 'dir', 'ls', 'tree', 'type', 'where', 'whoami']);
  const gitReadOnly = new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'describe', 'remote']);
  const pkgHeads = new Set(['npm', 'pnpm', 'yarn', 'bun']);
  const pkgSecondOk = new Set(['test', 'run', 'build', 'lint', 'typecheck', 'check', '--version', '-v', 'ls', 'list', 'why', 'outdated', 'exec']);
  const versionOnly = new Set(['--version', '-v']);
  const npxTools = new Set(['tsc', 'eslint', 'prettier', 'vitest', 'jest', 'mocha']);

  let allowed = false;
  if (plainHeads.has(head)) allowed = true;
  else if (head === 'git' && gitReadOnly.has(second)) allowed = true;
  else if (pkgHeads.has(head) && pkgSecondOk.has(second)) allowed = true;
  else if ((head === 'node' || head === 'npm' || head === 'npx') && versionOnly.has(second)) allowed = true;
  else if (head === 'npx' && npxTools.has(second)) allowed = true;
  else if (head === 'tsc' || head === 'eslint') allowed = true;

  if (allowed) return { verdict: 'allow' };
  return { verdict: 'confirm', reason: `Command is outside the safe allowlist and requires user confirmation: ${trimmed.slice(0, 120)}` };
}

// ---------------------------------------------------------------------------
// 各工具实现。ctx = { config, workspace, confirmed:boolean }
// ---------------------------------------------------------------------------

function walkTree(root, rel, depth, out) {
  const abs = path.join(root, rel);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
  for (const e of entries) {
    if (out.count >= TREE_MAX_ENTRIES) {
      out.truncated = true;
      return;
    }
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.count++;
      out.lines.push(`${'  '.repeat(depth)}${e.name}/`);
      if (depth + 1 < out.maxDepth) walkTree(root, childRel, depth + 1, out);
    } else if (e.isFile()) {
      out.count++;
      out.lines.push(`${'  '.repeat(depth)}${e.name}`);
    }
  }
}

function toolTree(ctx, args) {
  const root = resolveWorkspace(ctx.config, ctx.workspace);
  const relPath = args.path !== undefined ? String(args.path) : '.';
  const { abs } = validatePath(ctx.config, ctx.workspace, relPath, false);
  const st = fs.statSync(abs);
  const base = st.isDirectory() ? relPath : path.dirname(relPath);
  const out = { lines: [], count: 0, maxDepth: Math.min(Number(args.depth) || 3, 8), truncated: false };
  walkTree(root, base === '.' ? '' : base, 0, out);
  return {
    tree: out.lines.join('\n') || '(empty directory)',
    fileCount: out.count,
    truncated: out.truncated,
  };
}

function toolRead(ctx, args) {
  const { abs, posixRel } = validatePath(ctx.config, ctx.workspace, String(args.path), false);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new ToolError('E_ARGS_INVALID', `File not found: ${posixRel}`);
  }
  if (st.isDirectory()) throw new ToolError('E_ARGS_INVALID', `Target is a directory; use dsh_tree: ${posixRel}`);
  // 整读上限 READ_MAX_BYTES；带 offset/limit 范围读取时放宽到 RANGE_SCAN_MAX_BYTES（CodexPro 模式）
  const hasRange = args.offset !== undefined || args.limit !== undefined;
  if (st.size > READ_MAX_BYTES && !(hasRange && st.size <= RANGE_SCAN_MAX_BYTES)) {
    throw new ToolError('E_FORBIDDEN_PATH', `File exceeds the read limit (${READ_MAX_BYTES} bytes${hasRange ? `; range scan limit ${RANGE_SCAN_MAX_BYTES} bytes` : ''}): ${posixRel}`);
  }
  if (looksBinaryByExt(abs)) throw new ToolError('E_BINARY_FILE', `Likely binary file (based on extension): ${posixRel}`);
  const buf = fs.readFileSync(abs);
  if (sniffBinary(buf)) throw new ToolError('E_BINARY_FILE', `Binary content detected (null bytes/BOM); reading denied: ${posixRel}`);
  const sourceText = buf.toString('utf8');
  let text = sourceText;
  if (args.jsonField !== undefined) {
    if (!['stdout', 'stderr', 'content', 'tree', 'diff'].includes(args.jsonField)) throw new ToolError('E_ARGS_INVALID', 'jsonField must be stdout, stderr, content, tree, or diff');
    let value;
    try { value = JSON.parse(sourceText); } catch { throw new ToolError('E_ARGS_INVALID', 'jsonField requires a valid JSON source file'); }
    if (!value || typeof value[args.jsonField] !== 'string') throw new ToolError('E_ARGS_INVALID', `JSON field is not a string: ${args.jsonField}`);
    text = value[args.jsonField];
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const totalLines = lines.length;
  let offset = Math.max(1, Number(args.offset) || 1);
  let limit = Math.min(Math.max(1, Number(args.limit) || 200), 2000);
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  return {
    file: posixRel,
    content: withLineNumbers(slice, offset),
    startLine: offset,
    endLine: offset + slice.length - 1,
    totalLines,
    truncated: offset - 1 + slice.length < totalLines,
    sha256: sha256(sourceText),
    ...(args.jsonField !== undefined ? { jsonField: args.jsonField } : {}),
  };
}

function toolWrite(ctx, args) {
  if (typeof args.content !== 'string') throw new ToolError('E_ARGS_INVALID', 'content must be a string');
  if (args.append !== undefined && typeof args.append !== 'boolean') throw new ToolError('E_ARGS_INVALID', 'append must be a boolean');
  if (args.append && (typeof args.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(args.expectedSha256))) throw new ToolError('E_ARGS_INVALID', 'Appending requires expectedSha256 from the preceding write or dsh_read');
  if (args.content.length > 2 * 1024 * 1024) throw new ToolError('E_ARGS_INVALID', 'content exceeds the 2MB limit');
  const { abs, posixRel, needConfirm } = validatePath(ctx.config, ctx.workspace, String(args.path), true);
  if (needConfirm && !ctx.confirmed) throw new ToolError('E_NEEDS_CONFIRM', `Confirm writing sensitive file: ${posixRel}`);
  const existed = fs.existsSync(abs);
  if (args.append && !existed) throw new ToolError('E_STALE_FILE', 'Append target no longer exists; inspect the workspace before retrying');
  let content = args.content;
  if (existed && args.expectedSha256) {
    const cur = fs.readFileSync(abs, 'utf8');
    if (sha256(cur) !== String(args.expectedSha256).toLowerCase()) {
      throw new ToolError('E_STALE_FILE', `File changed since it was read (sha256 mismatch); use dsh_read again before writing: ${posixRel}`);
    }
    if (args.append) content = cur + args.content;
  }
  if (content.length > 2 * 1024 * 1024) throw new ToolError('E_ARGS_INVALID', 'Resulting content exceeds the 2MB limit');
  const before = snapshotFile(ctx, posixRel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return { bytesWritten: Buffer.byteLength(args.content, 'utf8'), created: !existed, appended: Boolean(args.append), file: posixRel, sha256: sha256(content), change: fileChange(posixRel, before, content, !existed ? 'created' : args.append ? 'appended' : 'updated') };
}

function toolEdit(ctx, args) {
  if (typeof args.oldText !== 'string' || args.oldText === '') throw new ToolError('E_ARGS_INVALID', 'oldText must be a non-empty string');
  if (typeof args.newText !== 'string') throw new ToolError('E_ARGS_INVALID', 'newText must be a string');
  const { abs, posixRel, needConfirm } = validatePath(ctx.config, ctx.workspace, String(args.path), true);
  if (needConfirm && !ctx.confirmed) throw new ToolError('E_NEEDS_CONFIRM', `Confirm editing sensitive file: ${posixRel}`);
  if (!fs.existsSync(abs)) throw new ToolError('E_ARGS_INVALID', `File not found: ${posixRel}`);
  const text = fs.readFileSync(abs, 'utf8');
  if (args.expectedSha256 && sha256(text) !== String(args.expectedSha256).toLowerCase()) {
    throw new ToolError('E_STALE_FILE', `File changed since it was read (sha256 mismatch); use dsh_read again before editing: ${posixRel}`);
  }
  const parts = text.split(args.oldText);
  if (parts.length === 1) {
    throw new ToolError('E_ARGS_INVALID', `oldText was not found in the file (0 occurrences): ${posixRel}`);
  }
  if (parts.length > 2) {
    throw new ToolError('E_ARGS_INVALID', `oldText occurs ${parts.length - 1} times and must be unique. Include more context: ${posixRel}`);
  }
  const after = text.replace(args.oldText, args.newText);
  const before = snapshotFile(ctx, posixRel);
  fs.writeFileSync(abs, after, 'utf8');
  return { replaced: 1, file: posixRel, sha256: sha256(after), change: fileChange(posixRel, before, after, 'edited') };
}

const SEARCH_SKIP_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'zip', 'gz', 'tar', '7z', 'rar',
  'exe', 'dll', 'so', 'dylib', 'pdf', 'mp3', 'mp4', 'avi', 'mov', 'wav', 'flac',
  'wasm', 'woff', 'woff2', 'ttf', 'eot', 'otf', 'bin', 'db', 'sqlite', 'sqlite3',
  'node', 'pyc', 'class', 'jar', 'iso', 'msi', 'map', 'min.js',
]);

function searchWalk(dir, base, matcher, out) {
  if (out.matches.length >= out.maxResults || out.filesScanned >= SEARCH_MAX_FILES) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.matches.length >= out.maxResults || out.filesScanned >= SEARCH_MAX_FILES) return;
    const abs = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.dsh-pro') continue;
      searchWalk(abs, rel, matcher, out);
    } else if (e.isFile()) {
      const ext = e.name.split('.').pop().toLowerCase();
      if (SEARCH_SKIP_EXT.has(ext)) continue;
      out.filesScanned++;
      let text;
      try {
        const st = fs.statSync(abs);
        if (st.size > 1024 * 1024) continue;
        const buf = fs.readFileSync(abs);
        if (sniffBinary(buf)) continue;
        text = buf.toString('utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (matcher(lines[i])) {
          out.matches.push({ file: rel, line: i + 1, text: lines[i].slice(0, 240).replace(/\t/g, '  ') });
          if (out.matches.length >= out.maxResults) return;
        }
      }
    }
  }
}

function toolSearch(ctx, args) {
  if (typeof args.query !== 'string' || args.query === '') throw new ToolError('E_ARGS_INVALID', 'query must be a non-empty string');
  const root = resolveWorkspace(ctx.config, ctx.workspace);
  const relPath = args.path !== undefined ? String(args.path) : '.';
  const { abs } = validatePath(ctx.config, ctx.workspace, relPath, false);
  const st = fs.statSync(abs);
  const baseDir = st.isDirectory() ? abs : path.dirname(abs);
  const baseRel = st.isDirectory() ? (relPath === '.' ? '' : relPath.replace(/\\/g, '/')) : path.dirname(relPath).replace(/\\/g, '/');

  const maxResults = Math.min(Math.max(1, Number(args.maxResults) || 50), 200);
  let matcher;
  if (args.regex) {
    let re;
    try {
      re = new RegExp(args.query, args.caseSensitive ? '' : 'i');
    } catch (e) {
      throw new ToolError('E_ARGS_INVALID', 'Invalid regular expression: ' + e.message);
    }
    matcher = (line) => re.test(line);
  } else {
    const needle = args.caseSensitive ? args.query : args.query.toLowerCase();
    matcher = (line) => (args.caseSensitive ? line.includes(needle) : line.toLowerCase().includes(needle));
  }
  const out = { matches: [], maxResults, filesScanned: 0 };
  if (st.isFile()) {
    // 单文件搜索
    const buf = fs.readFileSync(abs);
    if (!sniffBinary(buf)) {
      buf.toString('utf8').split('\n').forEach((line, i) => {
        if (out.matches.length < maxResults && matcher(line)) {
          out.matches.push({ file: baseRel ? `${baseRel}/${path.basename(abs)}` : path.basename(abs), line: i + 1, text: line.slice(0, 240) });
        }
      });
      out.filesScanned = 1;
    }
  } else {
    searchWalk(baseDir, baseRel, matcher, out);
  }
  return { matches: out.matches, truncated: out.matches.length >= maxResults, filesScanned: out.filesScanned };
}

function runCaptured(cmd, cmdArgs, cwd, timeoutMs, maxOut, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', ...opts?.env },
      ...(opts && opts.shell ? { shell: SHELL } : {}),
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let cleanupTimer;
    let childClosed = false;
    let exitCode = -1;
    let killerDone = false;
    let terminationConfirmed = false;
    function finish(extra = {}) {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(cleanupTimer);
      resolve({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), exitCode, truncated, timedOut, ...(timedOut ? { terminationConfirmed } : {}), ...extra });
    }
    const cap = (buf, chunk) => {
      if (buf.length >= maxOut) {
        truncated = true;
        return buf;
      }
      const merged = Buffer.concat([buf, chunk]);
      if (merged.length > maxOut) {
        truncated = true;
        return merged.slice(0, maxOut);
      }
      return merged;
    };
    child.stdout.on('data', (c) => (stdout = cap(stdout, c)));
    child.stderr.on('data', (c) => (stderr = cap(stderr, c)));
    const timer = setTimeout(() => {
      timedOut = true;
      // Cleanup must not block the bridge event loop or wait forever for inherited
      // pipe handles. Only terminate the process tree started by this invocation.
      cleanupTimer = setTimeout(() => {
        try { if (!terminationConfirmed) child.kill('SIGKILL'); } catch {}
        child.stdout.destroy(); child.stderr.destroy();
        finish();
      }, 3000);
      try {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 2500 });
          killer.on('error', () => { killerDone = true; try { child.kill('SIGKILL'); } catch {} if (childClosed) finish(); });
          killer.on('close', (code) => {
            killerDone = true; terminationConfirmed = code === 0;
            if (!terminationConfirmed) { try { child.kill('SIGKILL'); } catch {} }
            if (childClosed) finish();
          });
        } else child.kill('SIGKILL');
      } catch {}
    }, timeoutMs);
    child.on('error', (err) => {
      finish({ stderr: String(err.message), spawnError: true });
    });
    child.on('close', (code) => {
      childClosed = true; exitCode = code === null ? -1 : code;
      if (!timedOut || killerDone) finish();
      else if (process.platform !== 'win32') { terminationConfirmed = true; finish(); }
    });
  });
}

async function toolBash(ctx, args) {
  if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 20000) throw new ToolError('E_ARGS_INVALID', 'command must be a non-empty string of at most 20000 characters');
  const verdict = ctx.permissionMode === 'full' ? { verdict: 'allow' } : checkBashCommand(args.command);
  if (verdict.verdict === 'blocked') throw new ToolError('E_BASH_BLOCKED', verdict.reason);
  if (verdict.verdict === 'confirm' && !ctx.confirmed) {
    throw new ToolError('E_NEEDS_CONFIRM', verdict.reason);
  }
  const root = resolveWorkspace(ctx.config, ctx.workspace);
  const timeoutMs = Math.min(Math.max(1000, Number(args.timeoutMs) || ctx.config.bashTimeoutMs), ctx.config.bashTimeoutMaxMs);
  // Use the same explicit shell advertised by the catalog.
  const r = await runCaptured(args.command.trim(), [], root, timeoutMs, BASH_OUT_MAX, { shell: true });
  if (r.timedOut) throw new ToolError('E_TIMEOUT', `Command timed out (${timeoutMs}ms). ${r.terminationConfirmed ? 'Process termination confirmed.' : 'Termination requested; full cleanup could not be confirmed. Inspect before retrying.'} Narrow recursive searches to the project directory and prune dependency folders.`, {
    stdout: r.stdout, stderr: r.stderr.slice(0, 8192), exitCode: r.exitCode, truncated: r.truncated, timedOut: true, timeoutMs, terminationConfirmed: r.terminationConfirmed, shell: SHELL,
  });
  if (r.exitCode !== 0) {
    throw new ToolError('E_COMMAND_FAILED', `Command exited with code ${r.exitCode} in ${SHELL}.${!r.stdout.trim() && !r.stderr.trim() ? ' The process returned no stdout or stderr; the bridge received the exit status.' : ''}`, {
      stdout: r.stdout, stderr: r.stderr.slice(0, 8192), exitCode: r.exitCode, truncated: r.truncated, shell: SHELL,
    });
  }
  return {
    stdout: r.stdout,
    stderr: r.stderr.slice(0, 8192),
    exitCode: r.exitCode,
    truncated: r.truncated,
    shell: SHELL,
  };
}

function toolGitStatus(ctx, args) {
  const { abs, posixRel } = validatePath(ctx.config, ctx.workspace, args.path !== undefined ? String(args.path) : '.', false);
  const dir = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
  const r = spawnSync('git', ['-C', dir, 'status', '--porcelain=v1', '-b'], {
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 15000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (r.error || r.status !== 0) {
    throw new ToolError('E_INTERNAL', `git is unavailable or the directory is not a git repository: ${posixRel} :: ${(r.stderr || String(r.error)).slice(0, 300)}`);
  }
  const lines = String(r.stdout).split('\n').filter(Boolean);
  let branch = '';
  let ahead = null;
  let behind = null;
  const entries = [];
  for (const line of lines) {
    if (line.startsWith('## ')) {
      const m = line.match(/^##\s+([^.\s]+(?:\.[^.]+)?)(?:\s+\.\.\.)?.*?\[?(?:ahead (\d+))?,?\s*(?:behind (\d+))?\]?\s*$/);
      branch = (line.match(/^##\s+(\S+)/) || [])[1] || '';
      ahead = (line.match(/ahead (\d+)/) || [])[1] || null;
      behind = (line.match(/behind (\d+)/) || [])[1] || null;
    } else {
      entries.push(line);
    }
  }
  return { branch, ahead: ahead ? Number(ahead) : 0, behind: behind ? Number(behind) : 0, entries };
}

async function toolGitDiff(ctx, args) {
  const { abs, posixRel } = validatePath(ctx.config, ctx.workspace, args.path !== undefined ? String(args.path) : '.', false);
  const dir = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
  const gitArgs = ['-C', dir, 'diff', '--no-color'];
  if (args.staged) gitArgs.push('--staged');
  if (args.path !== undefined && fs.statSync(abs).isFile()) gitArgs.push('--', posixRel);
  const maxBytes = Math.min(Math.max(1024, Number(args.maxBytes) || DIFF_MAX_BYTES_DEFAULT), 256 * 1024);
  const r = await runCaptured('git', gitArgs, dir, 30000, maxBytes + 1);
  if (r.exitCode !== 0) throw new ToolError('E_INTERNAL', `git diff failed: ${r.stderr.slice(0, 300)}`);
  let diff = r.stdout;
  let truncated = false;
  let fullDiffFile = null;
  if (Buffer.byteLength(diff, 'utf8') > maxBytes) {
    truncated = true;
    const outsDir = path.join(dir, '.dsh-pro', 'outputs');
    fs.mkdirSync(outsDir, { recursive: true });
    const name = `diff-${Date.now()}.patch`;
    fs.writeFileSync(path.join(outsDir, name), diff, 'utf8');
    fullDiffFile = `.dsh-pro/outputs/${name}`;
    diff = Buffer.from(diff, 'utf8').slice(0, maxBytes).toString('utf8');
  }
  return { diff, truncated, fullDiffFile, empty: diff.trim() === '' };
}

// dsh_handoff 的实际逻辑在 handoff.js（异步任务模型）
function toolHandoff(ctx, args, handoff) {
  if (typeof args.planText !== 'string' || args.planText.trim() === '') {
    throw new ToolError('E_ARGS_INVALID', 'planText must be a non-empty string containing the complete plan');
  }
  const workspace = resolveWorkspace(ctx.config, ctx.workspace);
  return handoff.start({
    config: ctx.config,
    workspace,
    planText: args.planText,
    taskNote: typeof args.taskNote === 'string' ? args.taskNote : '',
    timeoutMs: args.timeoutMs !== undefined ? Number(args.timeoutMs) : undefined,
  });
}

// 读执行日志尾部（CodexPro execution-log.jsonl 模式的轻量版）
function toolLog(ctx, args) {
  const root = resolveWorkspace(ctx.config, ctx.workspace);
  const abs = path.join(root, LOG_REL_PATH);
  if (!fs.existsSync(abs)) return { log: '(no execution log yet)', lines: 0, file: LOG_REL_PATH };
  const n = Math.min(Math.max(1, Number(args.lines) || 100), 1000);
  const text = fs.readFileSync(abs, 'utf8');
  const all = text.split('\n').filter(Boolean);
  const tail = all.slice(-n);
  return { log: tail.join('\n'), lines: tail.length, totalEvents: all.length, file: LOG_REL_PATH };
}

// ---------------------------------------------------------------------------
// 执行日志：每次工具调用追加一条 JSONL 到 <workspace>/.dsh-pro/logs/execution-log.jsonl
// 参照 CodexPro：追加式、只增不改，供用户回溯"模型到底对我的电脑做了什么"。
// ---------------------------------------------------------------------------
const LOG_OMIT_KEYS = new Set(['content', 'newText', 'oldText', 'planText']);

function summarizeArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (LOG_OMIT_KEYS.has(k)) { out[k] = `<omitted ${String(v).length} characters>`; continue; }
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    const clean = redact(s);
    out[k] = clean.length > 160 ? clean.slice(0, 160) + `...(${clean.length} characters)` : clean;
  }
  return out;
}

function logExecution(ctx, name, args, result, error, durationMs) {
  try {
    const root = resolveWorkspace(ctx.config, ctx.workspace);
    const dir = path.dirname(path.join(root, LOG_REL_PATH));
    fs.mkdirSync(dir, { recursive: true });
    const event = {
      ts: new Date().toISOString(),
      tool: name,
      args: summarizeArgs(args),
      ok: !error,
      durationMs,
      workspace: ctx.workspace,
    };
    if (error) event.error = { code: error.code || 'E_INTERNAL', message: String(error.message).slice(0, 300) };
    if (result && typeof result === 'object' && result.runId) event.runId = result.runId;
    fs.appendFileSync(path.join(root, LOG_REL_PATH), JSON.stringify(event) + '\n', 'utf8');
  } catch {
    // 日志失败绝不影响主流程
  }
}

const coreHandlers = {
  dsh_tree: toolTree, dsh_read: toolRead, dsh_write: toolWrite,
  dsh_edit: toolEdit, dsh_search: toolSearch, dsh_bash: toolBash,
  dsh_git_status: toolGitStatus, dsh_git_diff: toolGitDiff,
  dsh_handoff: toolHandoff, dsh_log: toolLog,
};
const registry = createToolRegistry([
  CORE_DEFS.map((definition) => ({ definition, execute: coreHandlers[definition.name] })),
  ...require('./tool-modules')({ runCaptured }),
]);
const TOOL_DEFS = registry.definitions;

/** Unified entry point: all modules keep the same logging and error contract. */
async function runTool(name, args, ctx, handoff) {
  args = args && typeof args === 'object' ? args : {};
  const t0 = Date.now();
  try {
    const data = await registry.execute(name, args, ctx, handoff);
    logExecution(ctx, name, args, data, null, Date.now() - t0);
    // 每个成功结果都带上日志路径，模型/用户随时可 dsh_read 或 dsh_log 查看
    if (data && typeof data === 'object' && !data.logFile) data.logFile = LOG_REL_PATH;
    return data;
  } catch (e) {
    logExecution(ctx, name, args, null, e, Date.now() - t0);
    throw e;
  }
}

module.exports = { TOOL_DEFS, runTool, checkBashCommand, runCaptured, BASH_BLACKLIST_RE };
