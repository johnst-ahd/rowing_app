import type { ActiveRecording } from './background-session';
import type { NativeActiveSession } from './native-capsize-monitor';

export type ResumeCandidate = {
  sessionId: string;
  deviceId: string;
  startedAt?: number;
  athleteId?: string;
  serviceRunning: boolean;
};

export type ResumeDecision =
  | { action: 'none' }
  | { action: 'mismatch'; savedDeviceId: string; settingsDeviceId: string }
  | { action: 'resume'; candidate: ResumeCandidate };

/** Whether persisted or native state indicates an interrupted recording. */
export function canAutoResume(
  native: NativeActiveSession | null,
  persisted: ActiveRecording | null,
): boolean {
  return (
    Boolean(native?.active && native.sessionId && native.deviceId) ||
    Boolean(persisted?.sessionId && persisted.deviceId)
  );
}

/** Pick session metadata for auto-resume; null when nothing to restore. */
export function resolveResumeCandidate(
  native: NativeActiveSession | null,
  persisted: ActiveRecording | null,
  settingsDeviceId: string,
): ResumeDecision {
  if (!canAutoResume(native, persisted)) {
    return { action: 'none' };
  }

  const useNative = Boolean(native?.active && native.sessionId && native.deviceId);
  const sessionId = useNative ? native!.sessionId! : persisted!.sessionId;
  const deviceId = useNative ? native!.deviceId! : persisted!.deviceId;

  if (settingsDeviceId.trim() !== deviceId.trim()) {
    return { action: 'mismatch', savedDeviceId: deviceId, settingsDeviceId };
  }

  return {
    action: 'resume',
    candidate: {
      sessionId,
      deviceId,
      startedAt: native?.startedAt ?? persisted?.startedAt,
      athleteId: native?.athleteId,
      serviceRunning: Boolean(native?.serviceRunning),
    },
  };
}
