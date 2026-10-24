'use strict';
const { ToolError } = require('./guard');

// Modules supply metadata and handlers together. /tools and execution therefore
// share one catalog; adding a module does not require another dispatch switch.
function createToolRegistry(modules) {
  const entries = new Map();
  for (const tools of modules) {
    for (const tool of tools) {
      const name = tool.definition?.name;
      if (!/^dsh_[a-z0-9_]+$/.test(name || '') || typeof tool.execute !== 'function') throw new Error('Invalid tool registration');
      if (entries.has(name)) throw new Error('Duplicate tool registration: ' + name);
      entries.set(name, tool);
    }
  }
  return {
    definitions: Array.from(entries.values(), (tool) => tool.definition),
    async execute(name, args, ctx, handoff) {
      const tool = entries.get(name);
      if (!tool) throw new ToolError('E_TOOL_NOT_FOUND', `Unknown tool: ${name}`);
      const approval = typeof tool.requiresConfirmation === 'function' ? tool.requiresConfirmation(args) : tool.requiresConfirmation;
      if (approval && !ctx.confirmed) throw new ToolError('E_NEEDS_CONFIRM', `Confirm ${tool.definition.description}: ${JSON.stringify(args)}`);
      return tool.execute(ctx, args, handoff);
    },
  };
}

module.exports = { createToolRegistry };
