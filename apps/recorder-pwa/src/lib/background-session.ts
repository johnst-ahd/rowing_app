import type { RecorderSettings } from '@rowing/telemetry-types';
import { startKeepaliveAudio, stopKeepaliveAudio } from './keepalive-audio';
import {
  acquireWakeLock,
  bindWakeLockVisibility,
  releaseWakeLock,
} from './wake-lock';
import { requestOutboxBackgroundSync, saveUploadConfig } from '../session/store';

const LS_ACTIVE = 'rnz_active_recording_v1';
const LOCK_NAME = 'rnz-recording-session';
const IS_NATIVE = import.meta.env.VITE_PLATFORM === 'native';

export type BackgroundStatus = 'foreground' | 'background' | 'limited';

export type BackgroundSessionCallbacks = {
  onFlush: () => Promise<void>;
  onSync: () => Promise<void>;
  onLog: (msg: string) => void;
  onStatus?: (status: BackgroundStatus) => void;
};

const cleanups: Array<() => void> = [];
let lockAbort: AbortController | null = null;
let callbacks: BackgroundSessionCallbacks | null = null;

export function markRecordingActive(sessionId: string, deviceId: string): void {
  sessionStorage.setItem(
    LS_ACTIVE,
    JSON.stringify({ sessionId, deviceId, startedAt: Date.now() }),
  );
}

export function clearRecordingActive(): void {
  sessionStorage.removeItem(LS_ACTIVE);
}

export function getInterruptedRecording(): {
  sessionId: string;
  deviceId: string;
  startedAt: number;
} | null {
  try {
    const raw = sessionStorage.getItem(LS_ACTIVE);
    if (!raw) return null;
    return JSON.parse(raw) as { sessionId: string; deviceId: string; startedAt: number };
  } catch {
    return null;
  }
}

function setStatus(status: BackgroundStatus): void {
  callbacks?.onStatus?.(status);
}

async function flushAndSync(reason: string): Promise<void> {
  if (!callbacks) return;
  callbacks.onLog(`${reason} — saving queued data…`);
  await callbacks.onFlush();
  await callbacks.onSync();
  await requestOutboxBackgroundSync();
}

export async function startBackgroundSession(
  settings: RecorderSettings,
  cb: BackgroundSessionCallbacks,
): Promise<void> {
  stopBackgroundSession();
  callbacks = cb;

  await saveUploadConfig({
    deviceId: settings.deviceId,
    athleteId: settings.athleteId,
    ingestUrl: settings.ingestUrl,
    ingestToken: settings.ingestToken,
  });

  if (settings.keepScreenOn) {
    const ok = await acquireWakeLock();
    if (ok) cb.onLog('Screen wake lock active.');
    else cb.onLog('Wake lock unavailable — keep app in foreground if possible.');
    cleanups.push(bindWakeLockVisibility());
  }

  const backgroundEnabled = IS_NATIVE || settings.enableBackgroundRecording;

  if (backgroundEnabled) {
    // Native: background-geolocation foreground service keeps GPS + bridge alive.
    if (!IS_NATIVE) {
      const audioOk = await startKeepaliveAudio(settings.deviceId);
      if (audioOk) cb.onLog('Background keep-alive started (best effort).');
      else cb.onLog('Background keep-alive blocked — allow audio or keep app open.');
    } else if (settings.enableGps) {
      cb.onLog(
        'Android/iOS: persistent notification while recording — do not swipe app away from recents.',
      );
    }

    if ('locks' in navigator) {
      lockAbort = new AbortController();
      void navigator.locks.request(
        LOCK_NAME,
        { mode: 'exclusive', signal: lockAbort.signal },
        async () => {
          await new Promise<void>((resolve) => {
            lockAbort?.signal.addEventListener('abort', () => resolve(), { once: true });
          });
        },
      );
    }
  }

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      setStatus('background');
      void flushAndSync('App backgrounded');
    } else {
      setStatus('foreground');
      if (settings.keepScreenOn) void acquireWakeLock();
    }
  };

  const onPageHide = () => {
    void flushAndSync('Page closing');
  };

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('beforeunload', onPageHide);
  cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));
  cleanups.push(() => window.removeEventListener('pagehide', onPageHide));
  cleanups.push(() => window.removeEventListener('beforeunload', onPageHide));
}

export function stopBackgroundSession(): void {
  for (const fn of cleanups.splice(0)) fn();
  lockAbort?.abort();
  lockAbort = null;
  void releaseWakeLock();
  stopKeepaliveAudio();
  callbacks = null;
}
