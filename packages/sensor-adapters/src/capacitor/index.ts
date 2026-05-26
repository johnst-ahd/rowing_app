import { startGpsWatcher } from './gps';
import { startMotionWatcher } from './motion';
import { connectHeartRate } from './heart-rate';
import {
  requestNativePermissions,
  type NativePermissionStatus,
} from './permissions';

export { pollNativeAccelerometerReading } from './native-motion';
export { startGpsWatcher, startMotionWatcher, connectHeartRate, requestNativePermissions };
export type { GpsWatcherOptions } from './gps';
export type { MotionWatcherOptions } from './motion';
export type { NativePermissionStatus };
export type * from '../types';
