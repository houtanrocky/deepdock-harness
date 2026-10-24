# Chrome Web Store upload fields

Use these values in the Store listing tab. The title and summary come from the extension package; upload the new version 0.2.3 package to get the blue whale icon.

| Dashboard field | Value or file |
| --- | --- |
| Title from package | DeepDock Harness |
| Summary from package | An agent harness for DeepSeek: local tools, durable tasks, permissions, and handoff. |
| Description | Copy the complete contents of [description.txt](description.txt). It is plain text and below the 16,000-character limit. |
| Category | Productivity |
| Language | English (`en`) |
| Store icon | [extension/store-icon-128.png](extension/store-icon-128.png) — 128 × 128 PNG with transparent padding |
| Global promo video / YouTube URL | Leave blank. No public YouTube promo video has been produced. |
| Small promo tile | [promotional/small-promo-440x280.jpg](promotional/small-promo-440x280.jpg) |
| Marquee promo tile | [promotional/marquee-1400x560.jpg](promotional/marquee-1400x560.jpg) |
| Official URL | Keep **None** unless the project website is already verified in your Google Search Console account. The public website URL alone does not verify ownership. |
| Homepage URL | https://houtanrocky.github.io/deepdock-harness/ |
| Support URL | https://github.com/houtanrocky/deepdock-harness/issues |

## Screenshots, in upload order

All five are 1280 × 800 RGB JPEGs with square corners and no alpha channel.

1. [Local workspace](screenshots/01-local-workspace.jpg) — files, commands, and task activity.
2. [Review file diffs](screenshots/02-review-file-diffs.jpg) — an expanded, recorded file change.
3. [Permission controls](screenshots/03-permission-controls.jpg) — the real approval prompt.
4. [Resume work](screenshots/04-resume-work.jpg) — recovery after a reload.
5. [Local bridge setup](screenshots/05-local-bridge-setup.jpg) — the actual Settings panel, without a pairing token.

The captures load the built MV3 extension and exercise its UI through the local browser test fixture. The extension panel is real; the task data is illustrative. Each image labels the demo context. No production account, private project, or credential is included. The title and feature copy are a branded explanatory backdrop, not a replacement UI.

Preview the complete artwork in [asset-preview.html](asset-preview.html). Machine-readable field values are in [listing-fields.json](listing-fields.json), and capture provenance is in [screenshots/capture-manifest.json](screenshots/capture-manifest.json).

## Package and remaining dashboard fields

Upload `extension/deepdock-harness-0.2.3-chrome.zip` as the extension package. The store-assets ZIP is an artwork bundle to extract locally; it is not the extension package. The companion bridge installer is a separate user download.

Use the public privacy URL `https://houtanrocky.github.io/deepdock-harness/privacy.html`. The single-purpose statement, permission explanations, and data-use details remain in [store-listing.md](store-listing.md), [permissions.md](permissions.md), and [data-use-disclosure.md](data-use-disclosure.md).

For the Privacy tab, use [PRIVACY-ANSWERS.md](PRIVACY-ANSWERS.md). It includes the remote-code answer, all nine data categories, the three certifications, and copy-ready permission justifications. Structured values are in [privacy-fields.json](privacy-fields.json).

The optional video is intentionally empty. Official URL ownership and the dashboard's privacy certifications still depend on your publisher account; preparing files does not submit or certify the listing.

Artwork references: [Chrome image requirements](https://developer.chrome.com/docs/webstore/images) and [listing guidance](https://developer.chrome.com/docs/webstore/best-listing).
