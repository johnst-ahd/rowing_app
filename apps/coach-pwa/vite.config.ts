import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import { capacitorNativeHtml } from '../../packages/vite-plugins/capacitor-html.ts';

function readNativeAppVersion(): { version: string; versionCode: string } {
  const gradlePath = path.resolve(
    __dirname,
    '../coach-native/android/app/build.gradle',
  );
  if (!fs.existsSync(gradlePath)) {
    return { version: '0.1.0', versionCode: '1' };
  }
  const text = fs.readFileSync(gradlePath, 'utf8');
  return {
    version: text.match(/versionName\s+"([^"]+)"/)?.[1] ?? '0.1.0',
    versionCode: text.match(/versionCode\s+(\d+)/)?.[1] ?? '1',
  };
}

export default defineConfig(({ mode }) => {
  const isNative = mode === 'native';
  const nativeVersion = isNative ? readNativeAppVersion() : null;

  return {
    base: isNative ? './' : '/',
    build: {
      outDir: isNative
        ? path.resolve(__dirname, '../coach-native/www')
        : 'dist',
      emptyOutDir: true,
      modulePreload: false,
    },
    plugins: isNative ? [capacitorNativeHtml()] : [],
    define: {
      'import.meta.env.VITE_PLATFORM': JSON.stringify(isNative ? 'native' : 'web'),
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(
        nativeVersion?.version ?? '0.1.0',
      ),
    },
    server: {
      port: 5185,
      proxy: {
        '/api': {
          target: 'http://localhost:3000',
          changeOrigin: true,
        },
      },
    },
  };
});
