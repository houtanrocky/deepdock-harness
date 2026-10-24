# Store screenshots

Upload these five 1280 × 800 RGB JPEGs in order:

1. `01-local-workspace.jpg` — local tools and a completed task.
2. `02-review-file-diffs.jpg` — an expanded, recorded file diff.
3. `03-permission-controls.jpg` — the actual Allow once / Deny prompt.
4. `04-resume-work.jpg` — a checkpoint and explicit Resume after reload.
5. `05-local-bridge-setup.jpg` — the Settings panel with an empty token field.

The images capture the actual built MV3 extension in Chromium. Example model responses and bridge results come from the local browser test fixture. The branded explanatory backdrop labels this demo context; it does not imitate a live signed-in DeepSeek account. Production panel styles, labels, and controls are unchanged. No credentials or private project data appear.

`capture-manifest.json` records the extension version and capture method. Reproduce the images with `scripts/build-store-assets.mjs` after building the extension. `scripts/package-store-kit.mjs` checks dimensions, three RGB channels, 8-bit channel depth, and matching icon assets.
