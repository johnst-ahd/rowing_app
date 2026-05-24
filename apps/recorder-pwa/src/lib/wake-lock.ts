type WakeLockSentinel = {
  release: () => Promise<void>;
  addEventListener: (type: 'release', listener: () => void) => void;
};

let sentinel: WakeLockSentinel | null = null;
let wantLock = false;

export async function acquireWakeLock(): Promise<boolean> {
  wantLock = true;
  if (document.visibilityState !== 'visible') return false;
  const nav = navigator as Navigator & {
    wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinel> };
  };
  if (!nav.wakeLock) return false;
  try {
    if (sentinel) await sentinel.release().catch(() => undefined);
    sentinel = await nav.wakeLock.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
      if (wantLock && document.visibilityState === 'visible') {
        void acquireWakeLock();
      }
    });
    return true;
  } catch {
    return false;
  }
}

export async function releaseWakeLock(): Promise<void> {
  wantLock = false;
  if (!sentinel) return;
  try {
    await sentinel.release();
  } catch {
    /* optional */
  }
  sentinel = null;
}

export function bindWakeLockVisibility(): () => void {
  const onVisibility = () => {
    if (document.visibilityState === 'visible' && wantLock) {
      void acquireWakeLock();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  return () => document.removeEventListener('visibilitychange', onVisibility);
}
