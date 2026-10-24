import { protocol } from '../core/protocol.js';

// DeepSeek-specific DOM behavior stays behind this adapter. No tools execute here.
export function createDeepSeekAdapter({ platform, getCustomSelectors, selectors, checkRun, fail, aborted, responseTimeout = 180000, incompleteRenderGrace = 2000 }) {
  const { document, getComputedStyle, MutationObserver, HTMLTextAreaElement, HTMLInputElement,
    Event, InputEvent, KeyboardEvent, getSelection, setTimeout, clearTimeout } = platform;
  function selList(kind) {
    const custom = getCustomSelectors()?.[kind];
    return (custom ? (Array.isArray(custom) ? custom : [custom]) : []).concat(selectors[kind] || []);
  }
  function visible(el) {
    if (!el || el.closest?.('#dshpro-panel')) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (rect.width > 0 || rect.height > 0) && style.display !== 'none' && style.visibility !== 'hidden';
  }
  function lastVisible(list, scope = document, accept = () => true) {
    for (const selector of list) {
      try {
        const nodes = scope.querySelectorAll(selector);
        for (let i = nodes.length - 1; i >= 0; i--) if (visible(nodes[i]) && accept(nodes[i])) return nodes[i];
      } catch { /* Invalid custom selectors are reported in Diagnostics. */ }
    }
    return null;
  }
  function findInput() { return lastVisible(selList('input')); }
  const assistantContainers = '[data-message-author-role="assistant"], [data-role="assistant"], [data-message-role="assistant"], [data-testid="assistant-message"]';
  const excludedMessages = '[data-message-author-role="user"], [data-role="user"], [data-message-role="user"], [data-role="reasoning"], [data-testid="reasoning"], .ds-think-content';
  function newestAssistant(list) {
    let latest = null;
    for (const selector of list) {
      try {
        const matches = document.querySelectorAll(selector);
        for (let i = matches.length - 1; i >= 0; i--) {
          const element = matches[i];
          if (!visible(element) || element.closest(excludedMessages)) continue;
          // A markdown fragment can precede sibling code blocks. Read the whole
          // assistant message, never just the first matching markdown subtree.
          const root = element.closest('[data-virtual-list-item-key]') || element.closest(assistantContainers) || element;
          if (!latest || root.contains(latest) || (latest.compareDocumentPosition(root) & 4)) latest = root;
          break;
        }
      } catch { /* Ignore invalid custom selectors, as lastVisible does. */ }
    }
    return latest;
  }
  function findLastAssistant() {
    const custom = getCustomSelectors()?.assistantMessage;
    const override = custom && newestAssistant(Array.isArray(custom) ? custom : [custom]);
    return override || newestAssistant(selectors.assistantMessage || []) || newestAssistant(selList('assistantMarkdown'));
  }
  function composerScope(input) {
    return input?.closest('form, [data-testid="chat-input-area"], [class*="composer"]') || input?.parentElement?.parentElement || document;
  }
  function deepSeekComposerAction() {
    return lastVisible(['[role="button"].ds-button--primary.ds-button--circle:has(svg)'], composerScope(findInput()));
  }
  function isSendArrow(el) { return Boolean(el?.querySelector('svg path[d^="M8.3125"]')); }
  function findStopButton() {
    const explicit = lastVisible(selList('stopButton'));
    if (explicit) return explicit;
    const action = deepSeekComposerAction();
    return action && !isSendArrow(action) ? action : null;
  }
  function findSendButton() {
    const scope = composerScope(findInput());
    return lastVisible(selList('sendButton'), scope) || lastVisible(selList('sendButton'));
  }
  function stopButtonVisible() {
    return Boolean(findStopButton() || lastVisible(['[data-message-author-role="assistant"][aria-busy="true"]', '[data-role="assistant"][data-streaming="true"]']));
  }
  function enabledButton(button) { return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true' && !button.classList?.contains('ds-button--disabled'); }
  function findContinueButton(el) {
    if (!el) return null;
    const scope = el.closest('[data-virtual-list-item-key]') || el;
    const isControl = (node) => !node.closest(`pre, code, .ds-markdown, .markdown-body, ${excludedMessages}`);
    return lastVisible(selList('continueButton'), scope, isControl) || lastVisible(['button, [role="button"]'], scope, (node) =>
      isControl(node) && /^(?:continue(?: generating| generation| response)?|继续(?:生成|回答|写)?)$/i.test(node.textContent.replace(/\s+/g, ' ').trim()));
  }
  function inputText(input) { return input ? (input.value ?? input.innerText ?? input.textContent ?? '') : ''; }

  function assistantText(el) {
    if (!el) return '';
    // Reconstruct block boundaries while keeping PRE contents byte-for-byte. Code
    // toolbars are UI controls, not model output, and must not enter the parser.
    const clone = el.cloneNode(true);
    clone.querySelectorAll('ds_safety, ds-safety, button, [role="button"], .ds-code-block-banner, [data-testid="code-toolbar"], [data-role="reasoning"], [data-testid="reasoning"], .ds-think-content').forEach((node) => node.remove());
    function read(node) {
      if (node.nodeType === 3) return node.nodeValue;
      if (node.nodeType !== 1) return '';
      if (node.tagName === 'BR') return '\n';
      if (node.tagName === 'PRE') return '\n' + node.textContent + '\n';
      let text = '';
      let previous;
      for (const child of node.childNodes) {
        const part = read(child);
        // DeepSeek renders adjacent raw HTML blocks as sibling spans without a
        // separating text node. Restore that boundary instead of joining tags.
        if (previous?.classList?.contains('ds-markdown-html') && child.classList?.contains('ds-markdown-html') && !text.endsWith('\n') && !part.startsWith('\n')) text += '\n';
        text += part; previous = child;
      }
      // Some Markdown renderers turn ds_tool text into actual custom elements.
      // Reconstruct these protocol wrappers rather than dropping them as HTML.
      if (/^DS[_-]TOOL$/.test(node.tagName)) return '\n<' + node.tagName.toLowerCase() + '>' + text + '</' + node.tagName.toLowerCase() + '>\n';
      if (/^(DSML|FUNCTION_CALLS|TOOL_CALLS|INVOKE)$/.test(node.tagName)) return '\n<' + node.tagName.toLowerCase() + '>' + text + '</' + node.tagName.toLowerCase() + '>\n';
      return /^(DIV|P|LI|SECTION|ARTICLE|H[1-6])$/.test(node.tagName) ? '\n' + text + '\n' : text;
    }
    return read(clone).trim();
  }
  function assistantSnapshot() {
    const el = findLastAssistant();
    return { el, raw: assistantText(el) };
  }
  function completionIndicators(el) {
    const nodes = new Set();
    if (el.matches?.('[data-streaming="false"], [data-state="complete"], [aria-busy="false"]')) nodes.add(el);
    const item = el.closest?.('[data-virtual-list-item-key]') || el;
    item.querySelectorAll(`:is(${assistantContainers}):is([data-streaming="false"], [data-state="complete"], [aria-busy="false"])`).forEach((node) => nodes.add(node));
    for (const selector of selList('responseComplete')) {
      try { item.querySelectorAll(selector).forEach((node) => { if (visible(node) && enabledButton(node)) nodes.add(node); }); } catch {}
    }
    return nodes;
  }
  function containsStop(node) {
    if (node.nodeType !== 1) return false;
    return selList('stopButton').some((selector) => {
      try { return node.matches(selector) || Boolean(node.querySelector(selector)); } catch { return false; }
    });
  }

  // Arm this observer BEFORE clicking Send, so even a very fast stop-button
  // add/remove cycle is visible. The timeout only reports a stalled UI; it never
  // declares a partial response complete. Panel changes do not drive the loop.
  function waitForAssistant(run, baseline) {
    let cancel;
    const promise = new Promise((resolve, reject) => {
      let sawStreaming = stopButtonVisible();
      let settled = false;
      let candidate = null;
      let settleTimer;
      let continuationCount = 0;
      const clickedContinuations = new WeakMap();
      const previousIndicators = completionIndicators(document);
      const inactiveIndicators = new Set();
      const streamingTransitions = new Set();
      const observer = new MutationObserver((records) => inspect(records));
      const responseTimedOut = () => finish(fail('Timed out waiting for a completed assistant response. Open Diagnostics and check the streaming selectors.', 'E_responseTimeout'));
      let timeout = setTimeout(responseTimedOut, responseTimeout);
      const onAbort = () => finish(aborted());
      function finish(error, snapshot) {
        if (settled) return;
        settled = true;
        observer.disconnect(); clearTimeout(timeout); clearTimeout(settleTimer);
        run.controller.signal.removeEventListener('abort', onAbort);
        error ? reject(error) : resolve(snapshot);
      }
      function inspect(records = []) {
        try {
          checkRun(run);
          for (const record of records) {
            if (Array.from(record.addedNodes || []).some(containsStop) || Array.from(record.removedNodes || []).some(containsStop)) sawStreaming = true;
            if (record.type === 'attributes' && ((['aria-busy', 'data-streaming'].includes(record.attributeName) && record.oldValue === 'true') || (record.attributeName === 'data-state' && ['streaming', 'generating'].includes(record.oldValue)))) streamingTransitions.add(record.target);
          }
          for (const node of previousIndicators) if (!node.isConnected || !visible(node) || !enabledButton(node)) inactiveIndicators.add(node);
          const streaming = stopButtonVisible();
          sawStreaming ||= streaming;
          const current = assistantSnapshot();
          const changed = current.el && (current.el !== baseline.el || current.raw !== baseline.raw);
          const continueButton = changed && findContinueButton(current.el);
          if (continueButton) {
            candidate = null; clearTimeout(settleTimer);
            // A truncated response can already have a footer and even contain a
            // valid tool call. Continue it before allowing any final capture.
            if (!streaming && enabledButton(continueButton) && clickedContinuations.get(continueButton) !== current.raw) {
              clickedContinuations.set(continueButton, current.raw);
              continuationCount++;
              // The paused segment's footer cannot finish the resumed segment.
              for (const node of completionIndicators(current.el)) previousIndicators.add(node);
              inactiveIndicators.clear(); streamingTransitions.clear();
              checkRun(run);
              clearTimeout(timeout); timeout = setTimeout(responseTimedOut, responseTimeout);
              continueButton.click();
            }
            return;
          }
          const freshCompletion = current.el && [...completionIndicators(current.el)].some((node) => !previousIndicators.has(node) || inactiveIndicators.has(node) || streamingTransitions.has(node));
          // A composer Stop button can disappear briefly during generation. Only
          // completion evidence on this message can authorize a final capture.
          if (!changed || streaming || !freshCompletion) {
            candidate = null; clearTimeout(settleTimer); return;
          }
          // Completion controls can precede the final code-block render. Require
          // a terminal signal AND settled text; elapsed time alone never finishes
          // a response. Ignore panel mutations that do not change this snapshot.
          if (candidate?.el === current.el && candidate.raw === current.raw) return;
          const incomplete = protocol.parse(current.raw).errors.some((error) => error.code !== 'E_UNSUPPORTED_TOOL_FORMAT' && /incomplete|closing|framing|placeholder|invalid raw argument name/i.test(error.message));
          const settleMs = incomplete ? incompleteRenderGrace : 250;
          candidate = { ...current, since: Date.now() }; clearTimeout(settleTimer);
          settleTimer = setTimeout(() => {
            try {
              checkRun(run);
              const latest = assistantSnapshot();
              if (stopButtonVisible() || findContinueButton(latest.el) || latest.el !== candidate?.el || latest.raw !== candidate?.raw) { candidate = null; inspect(); return; }
              finish(null, { ...latest, completion: {
                streamingObserved: sawStreaming, freshIndicator: Boolean(freshCompletion), chars: latest.raw.length,
                continuationCount,
                capturedAt: new Date().toISOString(), settleMs, domStableMs: Date.now() - candidate.since,
                incompleteAfterGrace: incomplete, source: latest.el.tagName.toLowerCase() + (latest.el.className ? '.' + String(latest.el.className).trim().replace(/\s+/g, '.') : ''),
                messageKey: latest.el.getAttribute('data-virtual-list-item-key') || null,
              } });
            } catch (error) { finish(error); }
          }, settleMs);
        } catch (error) { finish(error); }
      }
      cancel = () => finish(aborted());
      run.controller.signal.addEventListener('abort', onAbort, { once: true });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeOldValue: true });
      inspect();
    });
    // Send failures can cancel this waiter before its caller begins awaiting it.
    promise.catch(() => {});
    return { promise, cancel };
  }
  function waitForDOM(predicate, signal, timeoutMs, errorMessage) {
    return new Promise((resolve, reject) => {
      const observer = new MutationObserver(inspect);
      const timer = setTimeout(() => finish(fail(errorMessage)), timeoutMs);
      function finish(error, value) {
        observer.disconnect(); clearTimeout(timer); signal.removeEventListener('abort', cancel);
        error ? reject(error) : resolve(value);
      }
      function cancel() { finish(aborted()); }
      function inspect() {
        if (signal.aborted) return cancel();
        try { const result = predicate(); if (result) finish(null, result); } catch (error) { finish(error); }
      }
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      signal.addEventListener('abort', cancel, { once: true });
      inspect();
    });
  }

  function setNativeValue(el, text) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      el.focus();
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(el); selection.removeAllRanges(); selection.addRange(range);
      if (!document.execCommand('insertText', false, text)) {
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
    }
  }
  return { selList, visible, lastVisible, findInput, findLastAssistant, composerScope, deepSeekComposerAction, isSendArrow, findStopButton, findSendButton, stopButtonVisible, enabledButton, findContinueButton, inputText, assistantText, assistantSnapshot, completionIndicators, containsStop, waitForAssistant, waitForDOM, setNativeValue };
}
