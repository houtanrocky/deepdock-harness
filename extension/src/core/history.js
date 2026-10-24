
// Only the outbound view is compacted. The persisted transcript stays intact.
export const history = (() => {
  function excerpt(value, limit) {
    const text = String(value ?? '');
    if (text.length <= limit) return text;
    const half = Math.floor((limit - 100) / 2);
    return text.slice(0, half) + `\n[Excerpt: ${text.length - 2 * half} characters omitted; inspect the original file/result before editing.]\n` + text.slice(-half);
  }
  function bounded(value, limit = 4000, depth = 0) {
    if (typeof value === 'string') return excerpt(value, limit);
    if (!value || typeof value !== 'object') return value;
    if (depth > 5) return '[Nested data omitted]';
    if (Array.isArray(value)) return value.slice(0, 40).map((item) => bounded(item, limit, depth + 1));
    return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [key, bounded(item, limit, depth + 1)]));
  }
  function argumentsView(args = {}) {
    return Object.fromEntries(Object.entries(args).map(([key, value]) => [key,
      ['content', 'oldText', 'newText', 'contentBase64'].includes(key) ? `[${String(value).length} characters archived; read the current file for exact content]` : bounded(value, 2000)]));
  }
  function project(entry, latestUser) {
    const common = { role: entry.role, ...(entry.workspace ? { workspace: entry.workspace } : {}), ...(entry.summary ? { summary: excerpt(entry.summary, 500) } : {}), ...(entry.tool_call_id ? { tool_call_id: entry.tool_call_id } : {}), ...(entry.tool ? { tool: entry.tool } : {}) };
    if (entry.kind === 'protocol') return null; // The live catalog is sent separately.
    if (entry.role === 'assistant' && entry.parseErrors?.length) return {
      ...common, kind: 'rejected-response', content: 'This response was rejected. No calls from this response executed.',
      parseErrors: entry.parseErrors.map((error) => ({ ...(error.code ? { code: error.code } : {}), message: excerpt(error.message, 1000) })),
    };
    if (entry.kind === 'tool-intent') return { ...common, kind: entry.kind, args: argumentsView(entry.args) };
    if (entry.role === 'tool') {
      let result = entry.result;
      if (!result) { try { result = JSON.parse(entry.content); } catch {} }
      return { ...common, ...(result ? { result: bounded(result, 8000) } : { content: excerpt(entry.content, 8000) }) };
    }
    if (entry.role === 'assistant' && entry.tool_calls?.length) return { ...common, ...(entry.narration ? { content: excerpt(entry.narration, 2000) } : {}), tool_calls: entry.tool_calls.map((call) => ({ tool: call.tool, ...(call.summary ? { summary: excerpt(call.summary, 500) } : {}), args: argumentsView(call.args) })) };
    return { ...common, ...(entry.kind ? { kind: entry.kind } : {}), content: excerpt(entry.content, entry === latestUser ? 60000 : 5000) };
  }
  function build(history, budget = 150000) {
    const latestUser = [...history].reverse().find((entry) => entry.role === 'user');
    const completed = new Set(history.filter((entry) => entry.role === 'tool').map((entry) => entry.tool_call_id));
    const rows = history.map((entry) => project(entry, latestUser));
    const selected = new Set();
    let used = 2000; // Envelope and omission notes.
    function include(index) {
      if (index < 0 || !rows[index] || selected.has(index)) return;
      const size = JSON.stringify(rows[index]).length + 1;
      if (used + size > budget) return;
      selected.add(index); used += size;
    }
    include(history.indexOf(latestUser));
    // Unresolved effects get priority over ordinary old prose.
    history.forEach((entry, index) => {
      if (entry.kind === 'tool-intent' && !completed.has(entry.tool_call_id)) include(index);
    });
    for (let i = rows.length - 1; i >= 0; i--) include(i);
    const omittedEntries = rows.filter((row, index) => row && !selected.has(index)).length;
    return {
      conversationHistory: rows.filter((row, index) => selected.has(index)),
      omittedEntries,
      note: 'This is a compact view; the full transcript remains saved locally. Code arguments are represented by metadata. Excerpts are not exact file content. Never replay successful tools. Inspect the workspace and remote before acting on unresolved intents, uncertain outcomes, or omitted earlier context.',
    };
  }
  return { build };
})();
