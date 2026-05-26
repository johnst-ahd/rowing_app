import { CapacitorAccelerometer } from '@capgo/capacitor-accelerometer';
import type { PluginListenerHandle } from '@capacitor/core';
import type { MotionReading, MotionWatcher } from '../types';

/** DeviceMotion / analyzer expect m/s² including gravity (~1 g ≈ 9.81). */
const GRAVITY_MS2 = 9.80665;

/**
 * Native SensorManager accelerometer — keeps delivering with screen off when the
 * Capacitor legacy bridge is alive (background GPS foreground service).
 */
export async function startNativeAccelerometerWatcher(
  onReading: (r: MotionReading) => void,
  intervalMs: number,
  onError?: (msg: string) => void,
): Promise<MotionWatcher> {
  try {
    const avail = await CapacitorAccelerometer.isAvailable();
    if (!avail.isAvailable) {
      onError?.('Native accelerometer not available');
      return { stop: () => {} };
    }
  } catch (e) {
    onError?.(e instanceof Error ? e.message : String(e));
    return { stop: () => {} };
  }

  try {
    const perm = await CapacitorAccelerometer.requestPermissions();
    if (perm.accelerometer === 'denied') {
      onError?.('Accelerometer access denied — enable in app settings');
      return { stop: () => {} };
    }
  } catch {
    /* some Android builds have no explicit motion permission */
  }

  let listener: PluginListenerHandle | null = null;
  let lastEmit = 0;
  let stopped = false;

  try {
    listener = await CapacitorAccelerometer.addListener('measurement', (m) => {
      if (stopped) return;
      if (m.x == null || m.y == null || m.z == null) return;
      const now = Date.now();
      if (now - lastEmit < intervalMs) return;
      lastEmit = now;
      onReading({
        ax: m.x * GRAVITY_MS2,
        ay: m.y * GRAVITY_MS2,
        az: m.z * GRAVITY_MS2,
        t: now,
      });
    });
    await CapacitorAccelerometer.startMeasurementUpdates();
  } catch (e) {
    onError?.(e instanceof Error ? e.message : String(e));
    return { stop: () => {} };
  }

  return {
    stop: async () => {
      stopped = true;
      try {
        await CapacitorAccelerometer.stopMeasurementUpdates();
      } catch {
        /* ignore */
      }
      await listener?.remove();
      listener = null;
    },
  };
}

/** Re-start sensor delivery after screen off (listener may pause on some devices). */
export async function kickNativeAccelerometer(): Promise<void> {
  try {
    await CapacitorAccelerometer.startMeasurementUpdates();
  } catch {
    /* optional */
  }
}

/** One-shot read — used when GPS wakes the app while the screen is off. */
export async function pollNativeAccelerometerReading(): Promise<MotionReading | null> {
  try {
    await kickNativeAccelerometer();
    const m = await CapacitorAccelerometer.getMeasurement();
    if (m.x == null || m.y == null || m.z == null) return null;
    return {
      ax: m.x * GRAVITY_MS2,
      ay: m.y * GRAVITY_MS2,
      az: m.z * GRAVITY_MS2,
      t: Date.now(),
    };
  } catch {
    return null;
  }
}
