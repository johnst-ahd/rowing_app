import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'nz.org.rowing.recorder',
  appName: 'CrewSight',
  webDir: '../recorder-pwa/dist',
  server: {
    androidScheme: 'https',
  },
  ios: {
    contentInset: 'automatic',
    backgroundColor: '#0a1628',
  },
  android: {
    backgroundColor: '#0a1628',
    /* Keeps Capacitor bridge alive with background-geolocation foreground service */
    useLegacyBridge: true,
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
    Geolocation: {
      /* iOS: enable "Location updates" background mode in Xcode (see docs/NATIVE-APP.md) */
    },
    BluetoothLe: {
      displayStrings: {
        scanning: 'Scanning for heart rate monitors…',
        cancel: 'Cancel',
        availableDevices: 'Available devices',
        noDeviceFound: 'No heart rate monitor found',
      },
    },
  },
};

export default config;
