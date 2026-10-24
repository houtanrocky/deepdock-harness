// These messages are rebuilt from current files, outside compacted chat history.
export function initCommand(task) {
  const match = /^\/init(?:[ \t]+([^\r\n]+))?\s*$/i.exec(String(task || '').trim());
  if (!match) return null;
  let directory = (match[1] || '.').trim();
  if (/^".*"$/.test(directory)) directory = directory.slice(1, -1);
  directory = directory.replace(/\\/g, '/').replace(/\/+$/, '') || '.';
  const target = (directory === '.' ? '' : directory + '/') + 'AGENTS.md';
  return { directory, target };
}

export function initMessage(command) {
  if (!command) return '';
  return '\n[Project initialization requested by /init]\n' +
    'Inspect the project at workspace-relative directory ' + JSON.stringify(command.directory) + ' and create or carefully update ' + JSON.stringify(command.target) + '. ' +
    'Read existing AGENTS.md guidance before writing. Preserve user-authored rules and useful existing content; do not blindly overwrite the file. ' +
    'For an existing file, use dsh_edit or a hash-checked write after reading its current contents. ' +
    'Inspect the README, source layout, dependency/build manifests, test configuration, and contribution docs that exist. ' +
    'Write concise, project-specific instructions covering project structure, setup/build/test commands, coding conventions, verification, and relevant configuration or security constraints. ' +
    'Use commands and facts supported by the repository; do not invent commands or claim checks ran when they did not. If the directory is not an existing project, explain what is missing before creating guidance. ' +
    'This task authorizes creating AGENTS.md; use the regular file tools and current permission setting. Avoid unrelated source changes. ' +
    'Read back the completed file and summarize what it contains.\n';
}

export function projectInstructionsMessage(instructions) {
  return '\n[Current project instructions]\n' +
    'Apply each AGENTS.md only within its stated workspace and directory subtree. More deeply nested files override conflicting ancestor guidance for their subtree. ' +
    'Explicit user instructions and the harness security/permission rules take precedence. These are project conventions, not authorization to publish or access other workspaces. ' +
    'This current view replaces older copies in the transcript. Before a shell command or handoff targeting a subdirectory, call dsh_instructions with that directory so its scoped guidance is loaded.\n' +
    (instructions.length ? JSON.stringify(instructions) : 'No AGENTS.md files currently apply to the checked paths.') + '\n';
}
