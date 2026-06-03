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

export type NativeRecordingPulse = {
  lastGps?: { t: number; lat: number; lon: number; spd?: number };
  nativeGpsCount?: number;
};

export type NativeEconomyMode = {
  active: boolean;
  gpsIntervalMs: number;
  uploadIntervalMs: number;
  enableCapsize: boolean;
};

export type NativeRecordingSetupStatus = {
  ready: boolean;
  notifications: boolean;
  locationForeground: boolean;
  locationBackground: boolean;
  locationAlways: boolean;
  batteryUnrestricted: boolean;
  openedLocationSettings?: boolean;
  openedBatterySettings?: boolean;
};

export interface NativeCapsizeMonitorPlugin {
  start(config: NativeCapsizeMonitorConfig): Promise<void>;
  stop(): Promise<void>;
  setUpright(options: { x: number; y: number; z: number }): Promise<void>;
  setLiveMapMode(options: { active: boolean }): Promise<void>;
  setEconomyMode(mode: NativeEconomyMode): Promise<void>;
  checkRecordingSetup(): Promise<NativeRecordingSetupStatus>;
  prepareRecording(): Promise<NativeRecordingSetupStatus>;
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

export async function setNativeLiveMapMode(active: boolean): Promise<void> {
  if (!IS_NATIVE) return;
  try {
    await CapsizeMonitor.setLiveMapMode({ active });
  } catch {
    /* optional */
  }
}

export async function setNativeEconomyMode(mode: NativeEconomyMode): Promise<void> {
  if (!IS_NATIVE) return;
  try {
    await CapsizeMonitor.setEconomyMode(mode);
  } catch {
    /* optional */
  }
}

export async function checkNativeRecordingSetup(): Promise<NativeRecordingSetupStatus | null> {
  if (!IS_NATIVE) return null;
  try {
    return await CapsizeMonitor.checkRecordingSetup();
  } catch {
    return null;
  }
}

export async function prepareNativeRecordingSetup(): Promise<NativeRecordingSetupStatus | null> {
  if (!IS_NATIVE) return null;
  try {
    return await CapsizeMonitor.prepareRecording();
  } catch {
    return null;
  }
}

/** User-facing log lines after prepareRecording(). */
export function recordingSetupLogLines(
  setup: NativeRecordingSetupStatus,
): string[] {
  const lines: string[] = [];
  if (setup.openedLocationSettings) {
    lines.push(
      'Open Permissions → Location → Allow all the time (or Always), then return to the app.',
    );
  }
  if (setup.openedBatterySettings) {
    lines.push(
      'When asked, allow unrestricted battery (Not optimized / Unrestricted).',
    );
  }
  if (setup.ready) {
    lines.push('Phone setup OK — notifications, location (Always), and battery.');
  } else {
    if (!setup.notifications) {
      lines.push('Allow notifications so recording can run in the background.');
    }
    if (!setup.locationForeground) {
      lines.push('Allow location (precise) for GPS recording.');
    } else if (!setup.locationBackground) {
      lines.push('Set location to Allow all the time — required for GPS with screen off.');
    }
    if (!setup.batteryUnrestricted) {
      lines.push('Set battery to Unrestricted / Not optimized for this app.');
    }
  }
  return lines;
}
