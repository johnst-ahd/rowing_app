import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'nz.org.rowing.coach',
  appName: 'CrewSight Manager',
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
