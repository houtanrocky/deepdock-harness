# Chrome Web Store submission kit

This folder contains the extension upload ZIP, copy-ready listing and privacy fields, the blue whale icon, five screenshots, both promotional tiles, and the companion Windows bridge installer. Start with [UPLOAD-GUIDE.md](UPLOAD-GUIDE.md), or open [asset-preview.html](asset-preview.html) to see the artwork.

Upload only `extension/deepdock-harness-0.2.2-chrome.zip` as the Chrome Web Store extension package. The store-assets ZIP is an artwork bundle to extract, and the bridge installer is a separate user download.

## Before submitting

1. Review `store-listing.md`, `permissions.md`, and `privacy-policy.md` against the release you intend to publish.
2. Review the developer identity and contact details in the privacy policy. The public policy is hosted at `https://houtanrocky.github.io/deepdock-harness/privacy.html`; enter that URL in the dashboard.
3. Upload the five screenshots from `screenshots/` in their numbered order. They show the actual built extension with clearly labeled local demo data. Upload the two images from `promotional/` to the corresponding promo fields.
4. In the dashboard, select the data categories described in `data-use-disclosure.md` and certify Limited Use only if those statements remain accurate for the submitted build.
5. Add the public extension support URL and the public companion bridge download URL to the listing. The local installer included here is for your review and release workflow; the store does not host it as part of the extension ZIP.

## Package contents

- `extension/deepdock-harness-0.2.2-chrome.zip`: production MV3 extension ZIP built from this checkout.
- `extension/store-icon-128.png`: 128 px listing icon copied from the extension.
- `screenshots/01-*.jpg` through `05-*.jpg`: five 1280 × 800 RGB JPEG screenshots.
- `promotional/small-promo-440x280.jpg`: small promotional tile.
- `promotional/marquee-1400x560.jpg`: marquee promotional tile.
- `description.txt`: complete plain-text description to paste into the dashboard.
- `listing-fields.json`: title, summary, description, category, language, URLs, and artwork paths.
- `PRIVACY-ANSWERS.md` and `privacy-fields.json`: all privacy form answers and checkbox values.
- `asset-report.json`: verified image dimensions, color channels, hashes, and description lengths.
- `asset-preview.html`: offline artwork gallery.
- `companion/DeepDock-Harness-Bridge-Setup-0.1.0-x64.exe`: separate Windows x64 bridge installer.
- `store-listing.md`: proposed listing fields and ready-to-paste description.
- `permissions.md`: permission and site-access justifications.
- `data-use-disclosure.md`: recommended privacy dashboard selections and wording.
- `privacy-policy.md`: source of the public privacy policy.
- `submission-checklist.md`: dashboard and asset checklist.
- `screenshots/README.md`: capture method, example-data disclosure, and upload order.

The package version is 0.2.2. Rebuild it with `npm run zip` after making release changes, then replace the ZIP here with the matching `.output/deepdock-harness-<version>-chrome.zip`.

## Rebuild the artwork

From the repository root, with the project's Chromium browser installed:

```powershell
node scripts/build-store-assets.mjs --icons
npm run build
node scripts/build-store-assets.mjs
npm run zip
node scripts/package-store-kit.mjs
```

The capture script uses a temporary browser profile and the local test fixture. It never signs in to DeepSeek, uses your bridge configuration, or runs tools against a private project. The icon source is `extension/src/assets/logo.svg`. Screenshots and promotional tiles are rendered as opaque RGB JPEGs; the 128px icon retains transparent padding.

Google's current [listing requirements](https://developer.chrome.com/docs/webstore/program-policies/listing-requirements/) require a description, icon, and screenshot. Its [image guidance](https://developer.chrome.com/docs/webstore/images/) specifies at least one screenshot at 1280x800 or 640x400. The [privacy dashboard guide](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy) requires the data declarations to agree with the public policy.
