import { registerPlugin } from '@capacitor/core';

const IS_NATIVE = import.meta.env.VITE_PLATFORM === 'native';

export type NativeCapsizeMonitorConfig = {
  sessionId: string;
  deviceId: string;
  ingestUrl: string;
  ingestToken?: string;
  athleteId?: string;
};

export interface NativeCapsizeMonitorPlugin {
  start(config: NativeCapsizeMonitorConfig): Promise<void>;
  stop(): Promise<void>;
  setUpright(options: { x: number; y: number; z: number }): Promise<void>;
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
    });
    return true;
  } catch {
    return false;
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
