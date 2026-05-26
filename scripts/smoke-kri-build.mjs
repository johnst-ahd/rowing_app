/**
 * Pre-APK smoke checks for KRI GPS native web bundle.
 * Run: node scripts/smoke-kri-build.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const www = path.join(root, 'apps', 'kri-native', 'www');

function fail(msg) {
  console.error('[smoke-kri-build] FAIL:', msg);
  process.exit(1);
}

console.log('[smoke-kri-build] building kri-gps native…');
execSync('npm run build:native -w kri-gps', { cwd: root, stdio: 'inherit' });

const indexPath = path.join(www, 'index.html');
if (!fs.existsSync(indexPath)) fail('missing apps/kri-native/www/index.html');

const html = fs.readFileSync(indexPath, 'utf8');
if (/crossorigin/i.test(html)) fail('index.html must not contain crossorigin (breaks Capacitor WebView)');
if (!/<script type="module" src="\.\/assets\/index-[^"]+\.js"><\/script>/.test(html)) {
  fail('index.html missing main module script');
}
if (!/<link rel="stylesheet" href="\.\/assets\/index-[^"]+\.css">/.test(html)) {
  fail('index.html missing stylesheet link');
}

const assetsDir = path.join(www, 'assets');
const jsFiles = fs.readdirSync(assetsDir).filter((f) => /^index-.*\.js$/.test(f));
if (jsFiles.length !== 1) fail(`expected 1 main index-*.js bundle, found ${jsFiles.length}`);

const mainJs = fs.readFileSync(path.join(assetsDir, jsFiles[0]), 'utf8');
if (mainJs.includes('unzo155E') || mainJs.includes('BluetoothLe')) {
  fail('main bundle still references Bluetooth (KRI must not load BLE)');
}

const logo = path.join(www, 'assets', 'kri', 'kri-logo.png');
if (!fs.existsSync(logo)) fail('missing bundled assets/kri/kri-logo.png');

console.log('[smoke-kri-build] OK — bundle ready for cap sync');
