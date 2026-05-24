import { Geolocation } from '@capacitor/geolocation';
import { startGpsWatcher } from './gps';
import { startMotionWatcher } from './motion';
import { connectHeartRate } from './heart-rate';

export { startGpsWatcher, startMotionWatcher, connectHeartRate };
export type * from '../types';

/** Request location (always when available) and motion permissions on native. */
export async function requestNativePermissions(): Promise<void> {
  try {
    await Geolocation.requestPermissions({ permissions: ['location', 'coarseLocation'] });
  } catch {
    /* user may grant later */
  }
}
