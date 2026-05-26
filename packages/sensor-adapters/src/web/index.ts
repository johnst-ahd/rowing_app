export { startGpsWatcher } from './gps';
export { startMotionWatcher } from './motion';
export { connectHeartRate } from './heart-rate';
export type * from '../types';
export type { NativePermissionStatus } from '../capacitor/permissions';

import type { MotionReading } from '../types';
import type { NativePermissionStatus } from '../capacitor/permissions';

/** Web/PWA build stub — native APK uses the Capacitor implementation. */
export async function pollNativeAccelerometerReading(): Promise<MotionReading | null> {
  return null;
}

export async function requestNativePermissions(): Promise<NativePermissionStatus> {
  return {
    location: 'n/a',
    notifications: 'n/a',
    accelerometer: 'n/a',
  };
}
