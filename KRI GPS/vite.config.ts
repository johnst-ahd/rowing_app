import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

function readNativeAppVersion(): { version: string; versionCode: string } {
  const gradlePath = path.resolve(
    __dirname,
    '../apps/recorder-native/android/app/build.gradle',
  );
  const text = fs.readFileSync(gradlePath, 'utf8');
  const version = text.match(/versionName\s+"([^"]+)"/)?.[1] ?? '';
  const versionCode = text.match(/versionCode\s+(\d+)/)?.[1] ?? '';
  return { version, versionCode };
}

function readWebAppVersion(): string {
  const pkgPath = path.resolve(__dirname, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
  return pkg.version ?? '';
}

export default defineConfig(({ mode }) => {
  const isNative = mode === 'native';
  const nativeVersion = isNative ? readNativeAppVersion() : null;
  const appVersion = nativeVersion?.version ?? readWebAppVersion();
  const appVersionCode = nativeVersion?.versionCode ?? '';

  return {
    base: isNative ? './' : '/',
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
    define: {
      'import.meta.env.VITE_PLATFORM': JSON.stringify(isNative ? 'native' : 'web'),
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
      'import.meta.env.VITE_APP_VERSION_CODE': JSON.stringify(appVersionCode),
    },
    resolve: {
      alias: {
        '@rowing/telemetry-types': path.resolve(
          __dirname,
          '../packages/telemetry-types/src/index.ts',
        ),
        '@rowing/motion-analysis': path.resolve(
          __dirname,
          '../packages/motion-analysis/index.js',
        ),
        '@rowing/sensor-adapters': path.resolve(
          __dirname,
          isNative
            ? '../packages/sensor-adapters/src/capacitor/index.ts'
            : '../packages/sensor-adapters/src/web/index.ts',
        ),
      },
    },
    server: {
      port: 5180,
      proxy: {
        '/api': {
          target: 'http://localhost:3000',
          changeOrigin: true,
        },
      },
    },
  };
});
