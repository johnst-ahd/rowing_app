import type { MotionSample } from '@rowing/telemetry-types';
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

export async function startMotionWatcher(
  onReading: (r: MotionReading) => void,
  intervalMs: number,
  onError?: (msg: string) => void,
): Promise<MotionWatcher> {
  if (!window.DeviceMotionEvent) {
    onError?.('DeviceMotion not supported');
    return { stop: () => {} };
  }

  const ok = await requestMotionPermission();
  if (!ok) {
    onError?.('Motion permission denied');
    return { stop: () => {} };
  }

  let last: MotionSample | null = null;

  const handler = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null || a.y == null || a.z == null) return;
    last = { ax: a.x, ay: a.y, az: a.z };
  };

  window.addEventListener('devicemotion', handler);

  const timer = setInterval(() => {
    if (last) onReading({ ...last, t: Date.now() });
  }, intervalMs);

  return {
    stop: () => {
      window.removeEventListener('devicemotion', handler);
      clearInterval(timer);
    },
  };
}

export type { MotionReading, MotionWatcher };
