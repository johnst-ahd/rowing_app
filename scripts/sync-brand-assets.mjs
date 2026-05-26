/**
 * Download RNZ / KRI brand images from traccar-overlay (KRI safety map assets).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base =
  'https://raw.githubusercontent.com/JohnSt-AHD/traccar-overlay/main/public';

const files = [
  {
    url: `${base}/assets/kri/kri-logo.png`,
    dest: path.join(root, 'KRI GPS/public/assets/kri/kri-logo.png'),
  },
  {
    url: `${base}/assets/kri/kri-favicon.png`,
    dest: path.join(root, 'KRI GPS/public/assets/kri/kri-favicon.png'),
  },
  {
    url: `${base}/assets/rnz/rnz-logo-white.png`,
    dest: path.join(root, 'apps/recorder-pwa/public/assets/rnz/rnz-logo-white.png'),
  },
  {
    url: `${base}/assets/rnz/rnz-logomark-white.png`,
    dest: path.join(root, 'apps/recorder-pwa/public/assets/rnz/rnz-logomark-white.png'),
  },
  {
    url: `${base}/altitude-hd-logo.png`,
    dest: path.join(root, 'apps/recorder-pwa/public/altitude-hd-logo.png'),
  },
  {
    url: `${base}/assets/kri/kri-favicon.png`,
    dest: path.join(root, 'apps/kri-native/assets/icon-source.png'),
  },
  {
    url: `${base}/assets/rnz/rnz-logomark-white.png`,
    dest: path.join(root, 'apps/recorder-native/assets/icon-source.png'),
  },
];

async function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log('OK', path.relative(root, dest), `(${buf.length} bytes)`);
}

for (const f of files) {
  await download(f.url, f.dest);
}

console.log('[sync-brand-assets] done');
