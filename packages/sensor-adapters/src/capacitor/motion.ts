import { Motion } from '@capacitor/motion';
import type { PluginListenerHandle } from '@capacitor/core';
import type { MotionReading, MotionWatcher } from '../types';

async function requestMotionPermission(): Promise<boolean> {
  const dm = DeviceMotionEvent as typeof DeviceMotionEvent & {
    requestPermission?: () => Promise<'granted' | 'denied'>;
  };
  if (typeof dm.requestPermission === 'function') {
    return (await dm.requestPermission()) === 'granted';
  }
  return true;
}

/** Uses Capacitor Motion (WebView DeviceMotion). GPS/BLE use full native APIs. */
export async function startMotionWatcher(
  onReading: (r: MotionReading) => void,
  intervalMs: number,
  onError?: (msg: string) => void,
): Promise<MotionWatcher> {
  const ok = await requestMotionPermission();
  if (!ok) {
    onError?.('Motion permission denied');
    return { stop: () => {} };
  }

  let last: MotionReading | null = null;
  let listener: PluginListenerHandle | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  try {
    listener = await Motion.addListener('accel', (ev) => {
      const a = ev.accelerationIncludingGravity ?? ev.acceleration;
      if (!a || a.x == null || a.y == null || a.z == null) return;
      last = { ax: a.x, ay: a.y, az: a.z, t: Date.now() };
    });
  } catch (e) {
    onError?.(e instanceof Error ? e.message : String(e));
    return { stop: () => {} };
  }

  timer = setInterval(() => {
    if (last) onReading({ ...last, t: Date.now() });
  }, intervalMs);

  return {
    stop: async () => {
      if (timer) clearInterval(timer);
      await listener?.remove();
    },
  };
}
