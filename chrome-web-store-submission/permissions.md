# Permission and site access justifications

These justifications correspond to the built extension manifest at version 0.2.0. Re-check the manifest whenever the extension changes.

## Required manifest permissions

### `storage`

Stores the user's bridge address and pairing token, selected workspace, permission mode, iteration settings, custom DeepSeek selectors, and conversation checkpoints. Temporary handoff state and tab ownership leases use session storage. This lets tasks recover after a page reload or service-worker suspension. Data is kept in Chrome extension storage on the user's device.

### `alarms`

Periodically wakes the extension service worker to check the status of a local-agent handoff if the DeepSeek tab is suspended. The alarm is created only while a handoff is being tracked and is cleared when no tracked handoffs remain.

## Host permission

### `http://127.0.0.1/*`

Allows the extension service worker to send authenticated requests to the user's local DeepDock Harness Bridge. The port is configurable, so access is scoped to the loopback host across ports. The extension's settings reject non-loopback bridge addresses. Requests carry the user-created bridge token in an Authorization header.

## Content script site access

### `https://chat.deepseek.com/*`

The content script adds the DeepDock Harness panel to DeepSeek Chat, reads the active conversation and model response needed to manage the requested coding task, and enters follow-up prompts into the chat composer after showing a cancellable preview. It runs only on DeepSeek Chat, not across arbitrary websites.

## Permissions not requested

The manifest does not request `tabs`, `activeTab`, `scripting`, `downloads`, clipboard access, or broad access to all websites. The bridge token is entered by the user and stored with `storage`; the extension does not read the clipboard.
