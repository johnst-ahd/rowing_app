/**
 * Ensure CrewSight brand assets are present in the recorder PWA public folder.
 * CrewSight logos are committed under assets/crewsight/ at repo root.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'assets/crewsight');
const destDir = path.join(root, 'apps/recorder-pwa/public/assets/crewsight');

if (!fs.existsSync(srcDir)) {
  console.warn('[sync-brand-assets] missing', path.relative(root, srcDir));
  process.exit(0);
}

fs.mkdirSync(destDir, { recursive: true });
for (const name of fs.readdirSync(srcDir)) {
  if (!name.endsWith('.png')) continue;
  fs.copyFileSync(path.join(srcDir, name), path.join(destDir, name));
  console.log('OK', path.relative(root, path.join(destDir, name)));
}

console.log('[sync-brand-assets] done');
