import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const project = fileURLToPath(new URL('../', import.meta.url));
process.chdir(project);
const kit = 'chrome-web-store-submission';
const manifest = JSON.parse(await fs.readFile('.output/chrome-mv3/manifest.json', 'utf8'));
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
const description = (await fs.readFile(kit + '/description.txt', 'utf8')).trim();
if (manifest.name !== 'DeepDock Harness' || manifest.version !== pkg.version) throw new Error('Build the current extension first.');
if (manifest.description.length > 132 || description.length > 16000) throw new Error('Listing text exceeds the dashboard limit.');

const screenshots = [
  '01-local-workspace.jpg', '02-review-file-diffs.jpg', '03-permission-controls.jpg', '04-resume-work.jpg', '05-local-bridge-setup.jpg',
].map((name) => 'screenshots/' + name);
const fields = {
  version: manifest.version,
  title: manifest.name,
  summary: manifest.description,
  description,
  descriptionCharacters: description.length,
  category: 'Productivity',
  language: 'English',
  locale: 'en',
  storeIcon: 'extension/store-icon-128.png',
  promoVideoYoutubeUrl: null,
  screenshots,
  smallPromoTile: 'promotional/small-promo-440x280.jpg',
  marqueePromoTile: 'promotional/marquee-1400x560.jpg',
  officialUrl: null,
  officialUrlNote: 'Select the project site only after verifying ownership through your Google Search Console account; otherwise keep None.',
  homepageUrl: 'https://houtanrocky.github.io/deepdock-harness/',
  supportUrl: 'https://github.com/houtanrocky/deepdock-harness/issues',
  privacyPolicyUrl: 'https://houtanrocky.github.io/deepdock-harness/privacy.html',
};
await fs.writeFile(kit + '/listing-fields.json', JSON.stringify(fields, null, 2) + '\n');

function jpegMetadata(data) {
  if (data[0] !== 255 || data[1] !== 216) throw new Error('Invalid JPEG signature');
  let offset = 2;
  while (offset + 10 < data.length) {
    if (data[offset] !== 255) throw new Error('Invalid JPEG marker');
    while (data[offset] === 255) offset++;
    const marker = data[offset++];
    if (marker === 217 || marker === 218) break;
    const length = data.readUInt16BE(offset);
    if ([192, 193, 194].includes(marker)) return { format: 'JPEG', width: data.readUInt16BE(offset + 5), height: data.readUInt16BE(offset + 3), bitsPerChannel: data[offset + 2], channels: data[offset + 7], alpha: false };
    offset += length;
  }
  throw new Error('JPEG frame header not found');
}
const assets = [];
for (const [file, width, height] of [
  [fields.storeIcon, 128, 128],
  ...screenshots.map((file) => [file, 1280, 800]),
  [fields.smallPromoTile, 440, 280],
  [fields.marqueePromoTile, 1400, 560],
]) {
  const data = await fs.readFile(path.join(kit, file));
  const image = file.endsWith('.png') ? { format: 'PNG', width: data.readUInt32BE(16), height: data.readUInt32BE(20), bitsPerChannel: data[24], channels: data[25] === 6 ? 4 : 3, alpha: data[25] === 6 } : jpegMetadata(data);
  if (image.width !== width || image.height !== height || image.bitsPerChannel !== 8) throw new Error('Image dimensions or depth do not match: ' + file);
  if (file.endsWith('.jpg') && (image.channels !== 3 || image.alpha)) throw new Error('Expected a 24-bit, opaque JPEG: ' + file);
  assets.push({ file, ...image, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
}

const storeIcon = await fs.readFile(kit + '/' + fields.storeIcon);
for (const file of ['extension/public/icons/icon128.png', '.output/chrome-mv3/icons/icon128.png', 'docs/assets/icon128.png']) {
  if (!storeIcon.equals(await fs.readFile(file))) throw new Error('Icon does not match the store asset: ' + file);
}
const builtContent = await fs.readFile('.output/chrome-mv3/content-scripts/content.js', 'utf8');
if (!builtContent.includes('M3 16.7C3 11.1')) throw new Error('The built panel does not contain the new whale mark.');
for (const file of ['background.js', 'content-scripts/content.js']) {
  const code = await fs.readFile('.output/chrome-mv3/' + file, 'utf8');
  if (/\beval\s*\(|new\s+Function\s*\(|WebAssembly/.test(code)) throw new Error('Review the remote-code disclosure for executable code loading: ' + file);
}
const privacy = JSON.parse(await fs.readFile(kit + '/privacy-fields.json', 'utf8'));
if (privacy.version !== manifest.version) throw new Error('Privacy fields refer to a different release.');
for (const field of ['singlePurposeDescription', 'storageJustification', 'alarmsJustification', 'hostPermissionJustification', 'remoteCodeJustification']) {
  if (privacy[field].length > 1000) throw new Error('Privacy field exceeds 1000 characters: ' + field);
}
await fs.copyFile('.output/deepdock-harness-' + manifest.version + '-chrome.zip', kit + '/extension/deepdock-harness-' + manifest.version + '-chrome.zip');

const listing = '# Chrome Web Store listing\n\n## Product name\n\n' + fields.title + '\n\n## Summary from package\n\n' + fields.summary + '\n\n## Category\n\n' + fields.category + '\n\n## Language\n\nEnglish (`en`)\n\n## Detailed description\n\n' + description + '\n\n## Single purpose statement\n\nDeepDock Harness turns a conversation on DeepSeek Chat into a user-controlled coding agent by connecting that conversation to local project tools through a separately installed loopback bridge.\n\n## Support and website fields\n\n- Homepage URL: ' + fields.homepageUrl + '\n- Support URL: ' + fields.supportUrl + '\n- Privacy policy URL: ' + fields.privacyPolicyUrl + '\n- Official URL: None until Search Console ownership is verified.\n- Global promo video: leave blank.\n\n## Artwork\n\nSee [UPLOAD-GUIDE.md](UPLOAD-GUIDE.md) for every field and image in upload order, and [asset-preview.html](asset-preview.html) for a visual preview.\n';
await fs.writeFile(kit + '/store-listing.md', listing);
await fs.writeFile(kit + '/asset-report.json', JSON.stringify({ extensionVersion: manifest.version, titleMatchesPackage: true, summaryMatchesPackage: true, summaryCharacters: fields.summary.length, descriptionCharacters: description.length, assets }, null, 2) + '\n');
console.log('Validated ' + assets.length + ' assets: exact sizes, 8-bit channels, RGB screenshots/tiles without alpha, and matching packaged icons.');
console.log('Description: ' + description.length + '/16000 characters. Summary: ' + fields.summary.length + '/132 characters.');
