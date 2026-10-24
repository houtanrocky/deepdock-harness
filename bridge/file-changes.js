'use strict';
const fs = require('fs');
const { validatePath, looksBinaryByExt, sniffBinary } = require('./guard');

// Observability uses the same read guards as file tools. In particular, an
// approved .env write must never expose its old secrets through a diff.
function snapshotFile(ctx, file) {
  try {
    const { abs } = validatePath(ctx.config, ctx.workspace, file, false);
    if (!fs.existsSync(abs)) return { text: '' };
    if (fs.statSync(abs).size > 512 * 1024 || looksBinaryByExt(abs)) return { note: 'Diff preview unavailable for a large or binary original file.' };
    const data = fs.readFileSync(abs);
    if (sniffBinary(data)) return { note: 'Diff preview unavailable for binary content.' };
    return { text: data.toString('utf8') };
  } catch {
    return { note: 'Diff preview unavailable: the original file cannot be read under the workspace policy.' };
  }
}

function fileChange(file, before, after, kind) {
  const change = { file, kind, diff: '', truncated: false };
  if (before.text === undefined) return { ...change, note: before.note };
  if (before.text === after) return { ...change, kind: kind === 'created' ? kind : 'unchanged', note: kind === 'created' ? 'Created an empty file.' : 'The file contents are unchanged.' };
  // One replacement hunk with context. This is an exact before/after preview,
  // bounded independently of file size; previews never pretend to be full patches.
  const lines = (text) => text ? text.match(/[^\n]*\n|[^\n]+$/g) || [] : [];
  const oldLines = lines(before.text);
  const newLines = lines(after);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let suffix = 0;
  while (suffix < oldLines.length - start && suffix < newLines.length - start && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
  const from = Math.max(0, start - 3);
  const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + 3);
  const newEnd = Math.min(newLines.length, newLines.length - suffix + 3);
  const output = [`--- ${kind === 'created' ? '/dev/null' : 'a/' + file}`, `+++ b/${file}`, `@@ -${oldEnd ? from + 1 : 0},${oldEnd - from} +${newEnd ? from + 1 : 0},${newEnd - from} @@`];
  let size = output.join('\n').length;
  function emit(prefix, line) {
    const value = prefix + line.replace(/\n$/, '');
    if (output.length >= 160 || size + value.length > 8000) { change.truncated = true; return false; }
    output.push(value); size += value.length + 1;
    if (!line.endsWith('\n')) output.push('\\ No newline at end of file');
    return true;
  }
  for (let i = from; i < start; i++) if (!emit(' ', oldLines[i])) break;
  for (let i = start; i < oldLines.length - suffix && !change.truncated; i++) if (!emit('-', oldLines[i])) break;
  for (let i = start; i < newLines.length - suffix && !change.truncated; i++) if (!emit('+', newLines[i])) break;
  for (let i = oldLines.length - suffix; i < oldEnd && !change.truncated; i++) if (!emit(' ', oldLines[i])) break;
  change.diff = output.join('\n');
  if (change.truncated) change.note = 'Diff preview shortened. Read the current file or run dsh_git_diff for more context.';
  return change;
}

module.exports = { snapshotFile, fileChange };
