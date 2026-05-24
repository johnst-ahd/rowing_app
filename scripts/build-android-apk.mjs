/**
 * Cross-platform APK build (Node). On Windows, prefer: npm run native:apk
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = path.join(root, 'apps', 'recorder-native');
const android = path.join(native, 'android');
const installDir = path.join(native, 'install');
const outApk = path.join(installDir, 'RNZ-Row-Recorder.apk');
const isWin = process.platform === 'win32';
const gradle = isWin ? 'gradlew.bat' : './gradlew';

function run(cmd, cwd = root) {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit', env: process.env });
}

run('npm run build:native -w recorder-pwa');
run('npx cap sync android', native);

if (!fs.existsSync(path.join(android, isWin ? 'gradlew.bat' : 'gradlew'))) {
  console.error('Missing android/. Run: cd apps/recorder-native && npx cap add android');
  process.exit(1);
}

run(`${gradle} assembleDebug`, android);

const built = path.join(android, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
if (!fs.existsSync(built)) {
  console.error('APK not found:', built);
  process.exit(1);
}

fs.mkdirSync(installDir, { recursive: true });
fs.copyFileSync(built, outApk);
console.log('\nAPK ready:', outApk);
console.log('Copy to your phone and tap the file to install.\n');
