'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ToolError, resolveWorkspace, validatePath, sniffBinary } = require('./guard');

const MAX_FILE_BYTES = 24 * 1024;
const MAX_TOTAL_BYTES = 48 * 1024;

// Walk only the ancestors of explicit targets, never recursively scan a workspace
// or read guidance above its authorized root. Missing targets may be new files.
function readProjectInstructions(config, workspace, paths = ['.']) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 64) throw new ToolError('E_ARGS_INVALID', 'Instruction paths must contain 1-64 workspace-relative paths');
  const root = resolveWorkspace(config, workspace);
  const candidates = new Set(['AGENTS.md']);
  for (const target of paths) {
    const { abs } = validatePath(config, workspace, target, false);
    let directory = path.dirname(abs);
    try { if (fs.statSync(abs).isDirectory()) directory = abs; }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    const relative = path.relative(root, directory);
    const parts = relative ? relative.split(path.sep) : [];
    for (let i = 1; i <= parts.length; i++) candidates.add(parts.slice(0, i).join('/') + '/AGENTS.md');
  }
  const checkedFiles = [...candidates].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  const instructions = [];
  let bytes = 0;
  for (const file of checkedFiles) {
    const { abs } = validatePath(config, workspace, file, false);
    let stat;
    try { stat = fs.statSync(abs); }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue; throw error; }
    if (!stat.isFile()) throw new ToolError('E_ARGS_INVALID', 'Project instructions must be a regular text file: ' + file);
    if (stat.size > MAX_FILE_BYTES || bytes + stat.size > MAX_TOTAL_BYTES) throw new ToolError('E_ARGS_INVALID', 'Project instructions exceed the context limit; shorten ' + file + ' before continuing');
    const buffer = fs.readFileSync(abs);
    bytes += buffer.length;
    if (buffer.length > MAX_FILE_BYTES || bytes > MAX_TOTAL_BYTES) throw new ToolError('E_ARGS_INVALID', 'Project instructions exceed the context limit: ' + file);
    if (sniffBinary(buffer)) throw new ToolError('E_BINARY_FILE', 'Project instructions must be UTF-8 text: ' + file);
    instructions.push({ path: file, scope: path.posix.dirname(file), content: buffer.toString('utf8').replace(/^\uFEFF/, ''), sha256: crypto.createHash('sha256').update(buffer).digest('hex') });
  }
  return { workspace: root, instructions, checkedFiles };
}

module.exports = { readProjectInstructions };
