// Prefer semantic roles/test IDs; keep localized labels and markdown fallbacks
// for existing DeepSeek layouts. Custom selectors are tried first.
export const selectors = {
  assistantMessage: [
    '.ds-assistant-message-main-content',
    '[data-message-author-role="assistant"]', '[data-role="assistant"]',
    '[data-message-role="assistant"]', '[data-testid="assistant-message"]',
  ],
  assistantMarkdown: ['div.ds-markdown', '.markdown-body', 'div[class*="markdown"]', 'div[class*="message-content"] div[class*="content"]'],
  messageContainer: ['div[class*="chat-container"]', 'div[class*="message-list"]', 'main [class*="scroll"]'],
  input: ['textarea#chat-input', 'textarea[id*="chat"]', '[role="textbox"][contenteditable="true"]', 'div[contenteditable="true"]', 'textarea[placeholder]'],
  sendButton: [
    '[role="button"].ds-button--primary.ds-button--circle:has(svg path[d^="M8.3125"])',
    '[data-testid="chat-input-send-button"]', '[data-testid="send-button"]', '[data-testid="send-message-button"]',
    'button[aria-label*="Send" i]', '[role="button"][aria-label*="Send" i]',
    'button[aria-label*="发送"]', '[role="button"][aria-label*="发送"]',
    'button[title*="Send" i]', '[role="button"][title*="发送"]',
    'div[class*="send"] button', 'button[class*="send"]', '[role="button"][class*="send"]', 'button[type="submit"]',
  ],
  stopButton: [
    '[data-testid="stop-button"]', '[data-testid="stop-generation-button"]',
    'button[aria-label*="Stop" i]', '[role="button"][aria-label*="Stop" i]',
    'button[aria-label*="停止"]', '[role="button"][aria-label*="停止"]',
    'button[title*="Stop" i]', '[role="button"][title*="停止"]', 'div[class*="stop"] button',
  ],
  continueButton: [
    '[data-testid="continue-button"]', '[data-testid="continue-generation-button"]',
    'button[aria-label="Continue" i]', '[role="button"][aria-label="Continue" i]',
    'button[aria-label="Continue generating" i]', '[role="button"][aria-label="Continue generating" i]',
    'button[aria-label="继续生成"]', '[role="button"][aria-label="继续生成"]',
  ],
  responseComplete: [
    '.ds-message + .ds-flex [role="button"][aria-disabled="false"]:has(svg path[d^="M7.92136"])',
    '.ds-message + .ds-flex [role="button"][aria-label="Read aloud"]',
    '[data-testid="message-actions"]', '[data-testid="copy-message-button"]',
    'button[aria-label*="Copy response" i]', 'button[aria-label*="复制回复"]',
    'button[aria-label*="Regenerate" i]', '[role="button"][aria-label*="重新生成"]',
  ],
};
