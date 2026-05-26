/**
 * Copy a source PNG into Android mipmap launcher foreground slots (all densities).
 * Usage: node scripts/apply-android-launcher-icon.mjs <android-app-dir> <source.png>
 */
import fs from 'node:fs';
import path from 'node:path';

const androidApp = process.argv[2];
const source = process.argv[3];
if (!androidApp || !source) {
  console.error(
    'Usage: node scripts/apply-android-launcher-icon.mjs <apps/.../android/app> <icon.png>',
  );
  process.exit(1);
}

if (!fs.existsSync(source)) {
  console.error('Missing source icon:', source);
  process.exit(1);
}

const res = path.join(androidApp, 'src', 'main', 'res');
const densities = [
  'mipmap-mdpi',
  'mipmap-hdpi',
  'mipmap-xhdpi',
  'mipmap-xxhdpi',
  'mipmap-xxxhdpi',
];

const buf = fs.readFileSync(source);
for (const d of densities) {
  const dir = path.join(res, d);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) {
    fs.writeFileSync(path.join(dir, name), buf);
  }
}

console.log('[apply-android-launcher-icon]', path.relative(process.cwd(), androidApp));
