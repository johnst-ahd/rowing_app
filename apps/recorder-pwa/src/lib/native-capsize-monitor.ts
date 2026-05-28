import { registerPlugin } from '@capacitor/core';

const IS_NATIVE = import.meta.env.VITE_PLATFORM === 'native';

export type NativeCapsizeMonitorConfig = {
  sessionId: string;
  deviceId: string;
  ingestUrl: string;
  ingestToken?: string;
  athleteId?: string;
  enableGps?: boolean;
  enableMotion?: boolean;
  gpsIntervalMs?: number;
};

export type NativeUploadStatus = {
  seq: number;
  ok: boolean;
  code: number;
  samples: number;
  okCount?: number;
  failCount?: number;
};

export type NativeRecordingPulse = {
  lastGps?: { t: number; lat: number; lon: number; spd?: number };
  nativeGpsCount?: number;
  upload?: NativeUploadStatus;
};

export interface NativeCapsizeMonitorPlugin {
  start(config: NativeCapsizeMonitorConfig): Promise<void>;
  stop(): Promise<void>;
  setUpright(options: { x: number; y: number; z: number }): Promise<void>;
  getPulse(): Promise<NativeRecordingPulse>;
}

const CapsizeMonitor = registerPlugin<NativeCapsizeMonitorPlugin>('CapsizeMonitor');

export async function startNativeCapsizeMonitor(
  config: NativeCapsizeMonitorConfig,
): Promise<boolean> {
  if (!IS_NATIVE) return false;
  try {
    await CapsizeMonitor.start({
      sessionId: config.sessionId,
      deviceId: config.deviceId,
      ingestUrl: config.ingestUrl,
      ingestToken: config.ingestToken ?? '',
      athleteId: config.athleteId ?? '',
      enableGps: config.enableGps ?? false,
      enableMotion: config.enableMotion ?? true,
      gpsIntervalMs: config.gpsIntervalMs ?? 1000,
    });
    return true;
  } catch {
    return false;
  }
}

export async function getNativeRecordingPulse(): Promise<NativeRecordingPulse | null> {
  if (!IS_NATIVE) return null;
  try {
    return await CapsizeMonitor.getPulse();
  } catch {
    return null;
  }
}

export async function stopNativeCapsizeMonitor(): Promise<void> {
  if (!IS_NATIVE) return;
  try {
    await CapsizeMonitor.stop();
  } catch {
    /* optional */
  }
}

export async function syncNativeCapsizeUpright(
  x: number,
  y: number,
  z: number,
): Promise<void> {
  if (!IS_NATIVE) return;
  try {
    await CapsizeMonitor.setUpright({ x, y, z });
  } catch {
    /* optional */
  }
}
