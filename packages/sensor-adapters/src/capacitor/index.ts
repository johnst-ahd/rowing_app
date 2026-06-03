import { startGpsWatcher } from './gps';
import { startMotionWatcher } from './motion';
import { connectHeartRate } from './heart-rate';
import {
  requestNativePermissions,
  type NativePermissionResult,
  type NativePermissionStatus,
} from './permissions';

export {
  kickNativeAccelerometer,
  pollNativeAccelerometerReading,
} from './native-motion';
export { startGpsWatcher, startMotionWatcher, connectHeartRate, requestNativePermissions };
export type { GpsWatcherOptions } from './gps';
export type { MotionWatcherOptions } from './motion';
export type { NativePermissionStatus, NativePermissionResult };
export type * from '../types';
