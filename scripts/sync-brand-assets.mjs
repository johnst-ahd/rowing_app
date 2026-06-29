/**
 * Ensure CrewSight brand assets are present in PWA public folders.
 * CrewSight logos are committed under assets/crewsight/ at repo root.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'assets/crewsight');
const themeSrc = path.join(root, 'apps/recorder-pwa/public/ahd-hub-theme.css');
const targets = [
  path.join(root, 'apps/recorder-pwa/public/assets/crewsight'),
  path.join(root, 'apps/coach-pwa/public/assets/crewsight'),
];

if (!fs.existsSync(srcDir)) {
  console.warn('[sync-brand-assets] missing', path.relative(root, srcDir));
  process.exit(0);
}

spawnSync(process.execPath, ['scripts/generate-crewsight-manager-icon.mjs'], {
  cwd: root,
  stdio: 'inherit',
});

for (const destDir of targets) {
  fs.mkdirSync(destDir, { recursive: true });
  const isCoach = destDir.includes('coach-pwa');
  for (const name of fs.readdirSync(srcDir)) {
    if (!name.endsWith('.png')) continue;
    if (name.includes('-manager-') && !isCoach) continue;
    fs.copyFileSync(path.join(srcDir, name), path.join(destDir, name));
    console.log('OK', path.relative(root, path.join(destDir, name)));
  }
}

if (fs.existsSync(themeSrc)) {
  const coachTheme = path.join(root, 'apps/coach-pwa/public/ahd-hub-theme.css');
  fs.mkdirSync(path.dirname(coachTheme), { recursive: true });
  fs.copyFileSync(themeSrc, coachTheme);
  console.log('OK', path.relative(root, coachTheme));
}

console.log('[sync-brand-assets] done');
