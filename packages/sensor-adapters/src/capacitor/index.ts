import { Geolocation } from '@capacitor/geolocation';
import { LocalNotifications } from '@capacitor/local-notifications';
import { startGpsWatcher } from './gps';
import { startMotionWatcher } from './motion';
import { connectHeartRate } from './heart-rate';

export { startGpsWatcher, startMotionWatcher, connectHeartRate };
export type { GpsWatcherOptions } from './gps';
export type { MotionWatcherOptions } from './motion';
export type * from '../types';

/** Location (always), notifications (Android 13+), motion permission. */
export async function requestNativePermissions(): Promise<void> {
  try {
    await Geolocation.requestPermissions({
      permissions: ['location', 'coarseLocation'],
    });
  } catch {
    /* user may grant later */
  }

  try {
    const notif = await LocalNotifications.checkPermissions();
    if (notif.display !== 'granted') {
      await LocalNotifications.requestPermissions();
    }
  } catch {
    /* optional on older Android */
  }
}
