import { registerPlugin } from '@capacitor/core';

export type CoachMonitorStatus = {
  active: boolean;
  serviceRunning: boolean;
};

export interface CoachMonitorPlugin {
  startMonitoring(options: {
    apiBaseUrl: string;
    ingestToken?: string;
    pollIntervalMs?: number;
  }): Promise<void>;
  stopMonitoring(): Promise<void>;
  getStatus(): Promise<CoachMonitorStatus>;
}

export const CoachMonitor = registerPlugin<CoachMonitorPlugin>('CoachMonitor');

export const IS_NATIVE = import.meta.env.VITE_PLATFORM === 'native';

export async function startNativeMonitoring(
  apiBaseUrl: string,
  ingestToken: string,
): Promise<void> {
  if (!IS_NATIVE) return;
  await CoachMonitor.startMonitoring({
    apiBaseUrl,
    ingestToken,
    pollIntervalMs: 3000,
  });
}

export async function stopNativeMonitoring(): Promise<void> {
  if (!IS_NATIVE) return;
  await CoachMonitor.stopMonitoring();
}

export async function getNativeMonitoringStatus(): Promise<CoachMonitorStatus> {
  if (!IS_NATIVE) return { active: false, serviceRunning: false };
  return CoachMonitor.getStatus();
}
