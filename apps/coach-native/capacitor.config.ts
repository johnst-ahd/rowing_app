import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'nz.org.rowing.coach',
  appName: 'RNZ Coach',
  webDir: 'www',
  server: {
    androidScheme: 'https',
  },
  android: {
    backgroundColor: '#0f172a',
    useLegacyBridge: true,
  },
};

export default config;
