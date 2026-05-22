import {
  DEFAULT_SETTINGS,
  type RecorderSettings,
} from '@rowing/telemetry-types';

const LS_KEY = 'rnz_recorder_settings_v1';

export function loadSettings(): RecorderSettings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: RecorderSettings): void {
  localStorage.setItem(LS_KEY, JSON.stringify(settings));
}

export function settingsFromForm(form: HTMLFormElement): RecorderSettings {
  const fd = new FormData(form);
  const num = (name: string, fallback: number) => {
    const v = Number(fd.get(name));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    deviceId: String(fd.get('deviceId') ?? '').trim(),
    athleteId: String(fd.get('athleteId') ?? '').trim(),
    traccarUrl: String(fd.get('traccarUrl') ?? '').trim().replace(/\/$/, ''),
    ingestUrl: String(fd.get('ingestUrl') ?? '/api/ingest').trim(),
    ingestToken: String(fd.get('ingestToken') ?? '').trim(),
    gpsIntervalMs: num('gpsIntervalMs', DEFAULT_SETTINGS.gpsIntervalMs),
    motionIntervalMs: num('motionIntervalMs', DEFAULT_SETTINGS.motionIntervalMs),
    uploadBatchMs: num('uploadBatchMs', DEFAULT_SETTINGS.uploadBatchMs),
    enableGps: fd.get('enableGps') === 'on',
    enableMotion: fd.get('enableMotion') === 'on',
    enableHr: fd.get('enableHr') === 'on',
  };
}
