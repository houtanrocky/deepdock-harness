# Chrome Web Store submission kit

This folder contains the extension upload ZIP, store listing text, permission and privacy disclosures, the extension icon, and the companion Windows bridge installer. Upload only `extension/deepdock-0.2.0-chrome.zip` as the Chrome Web Store package. The bridge installer is a separate download and is not part of the extension upload.

## Before submitting

1. Review `store-listing.md`, `permissions.md`, and `privacy-policy.md` against the release you intend to publish.
2. Replace every `[PLACEHOLDER]` in the privacy policy with a real developer identity, contact, and public URL. Publish the policy at a stable public HTTPS URL and enter that URL in the dashboard.
3. Capture at least one real product screenshot at 1280x800 or 640x400 and add it to `screenshots/`. The Chrome Web Store requires a screenshot; don't upload a mockup as if it were the product.
4. In the dashboard, select the data categories described in `data-use-disclosure.md` and certify Limited Use only if those statements remain accurate for the submitted build.
5. Add the public extension support URL and the public companion bridge download URL to the listing. The local installer included here is for your review and release workflow; the store does not host it as part of the extension ZIP.

## Package contents

- `extension/deepdock-0.2.0-chrome.zip`: production MV3 extension ZIP built from this checkout.
- `extension/store-icon-128.png`: 128 px listing icon copied from the extension.
- `companion/DeepDock-Bridge-Setup-0.1.0-x64.exe`: separate Windows x64 bridge installer.
- `store-listing.md`: proposed listing fields and ready-to-paste description.
- `permissions.md`: permission and site-access justifications.
- `data-use-disclosure.md`: recommended privacy dashboard selections and wording.
- `privacy-policy.md`: policy draft to publish after completing placeholders.
- `submission-checklist.md`: dashboard and asset checklist.
- `screenshots/README.md`: required screenshot guidance; real screenshots still need to be captured from your browser session.

The package version is 0.2.0. Rebuild it with `npm run zip` after making release changes, then replace the ZIP here with the matching `.output/deepdock-<version>-chrome.zip`.

Google's current [listing requirements](https://developer.chrome.com/docs/webstore/program-policies/listing-requirements/) require a description, icon, and screenshot. Its [image guidance](https://developer.chrome.com/docs/webstore/images/) specifies at least one screenshot at 1280x800 or 640x400. The [privacy dashboard guide](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy) requires the data declarations to agree with the public policy.
