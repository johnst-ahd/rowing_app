/**
 * Compose a square launcher icon: solid background + centered logo.
 * Usage: node scripts/generate-launcher-icon.mjs <logo.png> <out.png> --bg=black|white --scale=0.75
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const logoPath = args[0];
const outPath = args[1];
let bg = 'white';
let scale = 0.75;

for (let i = 2; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--bg' && args[i + 1]) {
    bg = args[++i];
    continue;
  }
  if (arg.startsWith('--bg=')) {
    bg = arg.slice(5);
    continue;
  }
  if (arg === '--scale' && args[i + 1]) {
    scale = Number(args[++i]);
    continue;
  }
  if (arg.startsWith('--scale=')) {
    scale = Number(arg.slice(8));
  }
}

if (!logoPath || !outPath) {
  console.error(
    'Usage: node scripts/generate-launcher-icon.mjs <logo.png> <out.png> [--bg=black|white] [--scale=0.75]',
  );
  process.exit(1);
}

const sharp = (await import('sharp')).default;
const size = 1024;
const logoSize = Math.round(size * scale);
const bgColor = bg === 'black' ? { r: 0, g: 0, b: 0, alpha: 1 } : { r: 255, g: 255, b: 255, alpha: 1 };

const logo = await sharp(path.resolve(root, logoPath))
  .resize(logoSize, logoSize, { fit: 'contain', background: bgColor })
  .png()
  .toBuffer();

fs.mkdirSync(path.dirname(path.resolve(root, outPath)), { recursive: true });

await sharp({
  create: { width: size, height: size, channels: 4, background: bgColor },
})
  .composite([{ input: logo, gravity: 'center' }])
  .png()
  .toFile(path.resolve(root, outPath));

console.log('[generate-launcher-icon]', path.relative(root, outPath), `bg=${bg} scale=${scale}`);
