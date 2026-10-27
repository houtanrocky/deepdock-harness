
// Shared by the content script and dependency-free Node regression tests.
export const protocol = (() => {
  const OPEN = '\u27e6DSH\u27e7';
  const CLOSE = '\u27e6/DSH\u27e7';
  const ARG_OPEN = '\u27e6DSH:ARG:';
  const DONE = /(?:^|\n)[ \t]*DSH:DONE[:：][ \t]*([\s\S]*)$/;
  const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);
  const foreignToolMarkup = /<\/?(?:[|\uFF5C]+\s*DSML(?:\s*[|\uFF5C]+)?|DSML\b|(?:function_calls|tool_calls|invoke)\b)|<\/?[|\uFF5C]+\s*(?:D(?:S(?:M(?:L)?)?)?)?\s*(?:$|(?=```\s*$))/i;

  // Repair only after strict parsing fails. Quotes inside string values that cannot
  // terminate a JSON value are escaped, as are literal control characters. No code
  // is evaluated, and ambiguous repairs that still fail are returned to the model.
  function repairJSON(raw) {
    let output = '';
    let quoted = false;
    let key = false;
    let previous = '';
    for (let i = 0; i < raw.length; i++) {
      const char = raw[i];
      if (!quoted) {
        output += char;
        if (char === '"') { quoted = true; key = previous === '{' || previous === ','; }
        if (!/\s/.test(char)) previous = char;
      } else if (char === '\\') {
        const next = raw[i + 1];
        if (next && /["\\/bfnrtu]/.test(next)) output += char + raw[++i];
        else output += '\\\\';
      } else if (char === '"') {
        const rest = raw.slice(i + 1).trimStart();
        const closes = key ? rest.startsWith(':') : /^[}\]]/.test(rest) || /^,\s*(?:"(?:[^"\\]|\\.)*"\s*:|[}\]])/.test(rest) || rest === '';
        if (closes) { output += char; quoted = false; previous = '"'; }
        else output += '\\"';
      } else if (char === '\n') output += '\\n';
      else if (char === '\r') output += '\\r';
      else if (char === '\t') output += '\\t';
      else if (char.charCodeAt(0) < 32) output += '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0');
      else output += char;
    }
    return output;
  }

  function parseJSON(raw) {
    try { return { value: JSON.parse(raw), repaired: false }; }
    catch (original) {
      try { return { value: JSON.parse(repairJSON(raw)), repaired: true }; }
      catch (error) {
        const failure = new Error(original.message + ' (repair failed: ' + error.message + ')');
        failure.raw = raw;
        throw failure;
      }
    }
  }

  function sanitize(raw) {
    let text = String(raw || '');
    // Only remove leading metadata. Literal safety tags in a file argument are data.
    while (true) {
      const before = text;
      text = text.replace(/^\s*<ds[_-]safety>[\s\S]*?<\/ds[_-]safety>\s*/i, '');
      text = text.replace(/^\s*\[用户未成年\][^\r\n]*\r?\n\s*\[分类\][^\r\n]*\r?\n\s*\[判定\][^\r\n]*?(?=\u27e6DSH\u27e7|\r?\n|$)(?:\r?\n)?/, '');
      if (before === text) break;
    }
    return text.trim();
  }

  function jsonEnd(text, start) {
    if (text[start] !== '{') throw new Error('Expected a JSON object after the opening DSH marker.');
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') {
        if (--depth === 0) return i + 1;
      }
    }
    throw new Error('Incomplete JSON header. Put code in raw argument blocks instead of a JSON string.');
  }

  function skipSpace(text, position) {
    while (position < text.length && /\s/.test(text[position])) position++;
    return position;
  }

  function nextOpening(text, position) {
    const pattern = /\u27e6DSH\u27e7|<(dsh?[_-]tool)\s*>/gi;
    pattern.lastIndex = position;
    const match = pattern.exec(text);
    return match ? { start: match.index, end: pattern.lastIndex, tag: match[1]?.toLowerCase() || null } : null;
  }
  function nextClosing(text, position, wrapper) {
    if (!wrapper.tag) {
      const pattern = /\u27e6\/DSH\u27e7/gi;
      pattern.lastIndex = position;
      const match = pattern.exec(text);
      return match ? { start: match.index, end: pattern.lastIndex } : null;
    }
    const pattern = new RegExp('</' + wrapper.tag + '\\s*>', 'gi');
    pattern.lastIndex = position;
    const match = pattern.exec(text);
    return match ? { start: match.index, end: pattern.lastIndex } : null;
  }

  function readBlock(text, position, wrapper) {
    position = skipSpace(text, position);
    let end;
    let header;
    let repaired = false;
    try {
      end = jsonEnd(text, position);
      header = JSON.parse(text.slice(position, end));
    } catch {
      const close = nextClosing(text, position, wrapper);
      if (!close) {
        const error = new Error('Incomplete tool call: missing closing DSH marker.');
        error.raw = text.slice(position);
        throw error;
      }
      const parsed = parseJSON(text.slice(position, close.start).trim());
      header = parsed.value;
      repaired = parsed.repaired;
      end = close.start;
    }
    if (!header || typeof header.tool !== 'string' || !header.tool.trim()) throw new Error('Missing non-empty tool name.');
    const args = header.args === undefined ? {} : header.args;
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('args must be a JSON object.');
    if (Object.keys(args).some((key) => forbiddenKeys.has(key))) throw new Error('Unsafe argument key.');
    position = skipSpace(text, end);
    const rawKeys = new Set();
    while (text.startsWith(ARG_OPEN, position)) {
      const markerEnd = text.indexOf('\u27e7', position);
      const key = text.slice(position + ARG_OPEN.length, markerEnd);
      if (markerEnd < 0 || !/^[A-Za-z_][\w-]*$/.test(key) || forbiddenKeys.has(key)) throw new Error('Invalid raw argument name.');
      if (rawKeys.has(key) || Object.hasOwn(args, key)) throw new Error('Duplicate argument: ' + key);
      rawKeys.add(key);
      const lineEnd = /^(?:\r?\n)/.exec(text.slice(markerEnd + 1));
      if (!lineEnd) throw new Error('Raw argument opening markers must be followed by a newline.');
      const contentStart = markerEnd + 1 + lineEnd[0].length;
      const closing = '\u27e6/DSH:ARG:' + key + '\u27e7';
      let contentEnd = text.indexOf(closing, contentStart);
      while (contentEnd >= 0 && (text[contentEnd - 1] !== '\n' || !/^(?:\r?\n|$)/.test(text.slice(contentEnd + closing.length)))) {
        contentEnd = text.indexOf(closing, contentEnd + closing.length);
      }
      if (contentEnd < 0) throw new Error('Missing closing raw argument marker for ' + key + '.');
      let value = text.slice(contentStart, contentEnd);
      // Remove just the framing newline, preserving the payload's other whitespace.
      value = value.replace(/\r?\n$/, '');
      args[key] = value;
      position = skipSpace(text, contentEnd + closing.length);
    }
    const close = nextClosing(text, position, wrapper);
    if (!close || close.start !== position) throw new Error('Missing closing DSH marker or unexpected text after tool arguments.');
    const summary = typeof header.summary === 'string' ? header.summary.trim().slice(0, 500) : '';
    return { call: { tool: header.tool, args, ...(summary ? { summary } : {}) }, end: close.end, repaired };
  }

  function parse(raw, { maxCalls = 3, knownTools, renderedRanges = [] } = {}) {
    const text = sanitize(raw);
    const sourceOffset = String(raw || '').indexOf(text);
    const wasRendered = (start, end) => renderedRanges.some((range) => range.start < end + sourceOffset && range.end > start + sourceOffset);
    const calls = [];
    const errors = [];
    let repaired = false;
    let position = 0;
    let blocks = 0;
    const spans = [];
    let wrapper;
    while ((wrapper = nextOpening(text, position))) {
      const start = wrapper.start;
      blocks++;
      if (blocks > maxCalls) {
        errors.push({ block: blocks, code: 'E_TOO_MANY_CALLS', message: `Too many calls; the maximum is ${maxCalls} per response.`, raw: text.slice(start) });
        break;
      }
      try {
        const parsed = readBlock(text, wrapper.end, wrapper);
        repaired ||= parsed.repaired;
        position = parsed.end;
        spans.push({ start, end: parsed.end });
        if (wasRendered(start, parsed.end)) throw new Error('Tool text was changed by Markdown rendering. Regenerate the entire tool block inside a fenced text code block.');
        if (knownTools && !knownTools.includes(parsed.call.tool)) throw new Error('Unknown tool: ' + parsed.call.tool);
        calls.push(parsed.call);
      } catch (error) {
        const close = nextClosing(text, wrapper.end, wrapper);
        const rendered = wasRendered(start, position > start ? position : close ? close.end : text.length);
        errors.push({ block: blocks, ...(rendered ? { code: 'E_RENDERED_TOOL_TEXT' } : {}), message: rendered ? 'Tool text was changed by Markdown rendering. Regenerate the entire tool block inside a fenced text code block.' : error.message, raw: error.raw || text.slice(wrapper.end, close ? close.start : text.length) });
        // Skip a rejected, closed block so marker literals inside malformed
        // arguments cannot masquerade as extra calls. Any error rejects the turn.
        position = Math.max(position, close ? close.end : wrapper.end);
      }
    }
    // Inspect only text outside consumed calls: literal markers in JSON strings
    // and raw code arguments belong to those arguments, not another tool call.
    let outside = ''; let end = 0;
    for (const span of spans) { outside += text.slice(end, span.start); end = span.end; }
    outside += text.slice(end);
    if (foreignToolMarkup.test(outside)) {
      errors.push({ block: blocks + 1, code: 'E_UNSUPPORTED_TOOL_FORMAT', message: 'Unsupported native tool-call markup (DSML). Use DSH markers and tools from the live catalog.', raw: outside });
    }
    if (!errors.length && (/\u27e6\/?D(?:S(?:H)?)?|\u27e6\/?$|<\/?dsh?[_-]tool\b/i.test(outside.trimEnd()) || /(?:^|\n)\s*(?:```(?:json|text)?\s*)?\{\s*"tool"\s*:/.test(outside))) {
      errors.push({ block: blocks + 1, message: 'Unrecognized or incomplete tool framing. Use a complete DSH block with both opening and closing markers.', raw: outside });
    }
    if (!calls.length && !errors.length && /^(?:(?:```\s*)?(?:text|safe)?\s*(?:```)?)$/i.test(text)) {
      errors.push({ block: 1, message: 'Empty or placeholder response; no tool call or task summary was received.', raw: text });
    }
    const done = calls.length === 0 && errors.length === 0 ? text.match(DONE) : null;
    const narration = calls.length && !errors.length ? outside.replace(/^\s*```(?:text|json)?\s*$/gm, '').trim() : '';
    return { text, calls, errors, repaired, narration, done: done ? done[1].trim() : null };
  }

  return { OPEN, CLOSE, sanitize, parse, repairJSON };
})();

