export { startGpsWatcher } from './gps';
export { startMotionWatcher } from './motion';
export { connectHeartRate } from './heart-rate';
export type * from '../types';

export async function requestNativePermissions(): Promise<void> {
  /* web — no native permissions */
}
