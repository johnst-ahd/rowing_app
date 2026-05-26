/**
 * Build KRI GPS debug APK (Node). Requires Android SDK + Java locally.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = path.join(root, 'apps', 'kri-native');
const android = path.join(native, 'android');
const installDir = path.join(native, 'install');
const outApk = path.join(installDir, 'KRI-GPS.apk');
const isWin = process.platform === 'win32';
const gradle = isWin ? 'gradlew.bat' : './gradlew';

function run(cmd, cwd = root) {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit', env: process.env });
}

run('node scripts/sync-brand-assets.mjs');
run(
  'node scripts/generate-launcher-icon.mjs "KRI GPS/public/assets/kri/kri-logo.png" apps/kri-native/assets/icon-source.png --bg=white --scale=0.75',
);
run('node scripts/smoke-kri-build.mjs');
run(
  'node scripts/apply-android-launcher-icon.mjs apps/kri-native/android/app apps/kri-native/assets/icon-source.png',
);
run('npx cap sync android', native);

if (!fs.existsSync(path.join(android, isWin ? 'gradlew.bat' : 'gradlew'))) {
  console.error('Missing android/. Run: cd apps/kri-native && npx cap add android');
  process.exit(1);
}

run(`${gradle} assembleDebug`, android);

const apkDir = path.join(android, 'app', 'build', 'outputs', 'apk', 'debug');
const built =
  ['app-arm64-v8a-debug.apk', 'app-debug.apk']
    .map((name) => path.join(apkDir, name))
    .find((p) => fs.existsSync(p));

if (!built) {
  console.error('APK not found under', apkDir);
  process.exit(1);
}

fs.mkdirSync(installDir, { recursive: true });
fs.copyFileSync(built, outApk);
console.log('\nAPK ready:', outApk);
console.log('Copy to your phone and tap the file to install.\n');
