'use strict';
const { readProjectInstructions } = require('../project-instructions');

module.exports = function instructionTools() {
  return [{
    definition: {
      name: 'dsh_instructions',
      description: 'Read root and applicable nested AGENTS.md instructions for workspace-relative file or directory paths. Use before shell commands or handoffs targeting a subdirectory',
      params: { paths: 'string[]? default ["."]; up to 64 file or directory paths' },
    },
    execute(ctx, args) { return readProjectInstructions(ctx.config, ctx.workspace, args.paths); },
  }];
};
