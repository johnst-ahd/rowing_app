import {
  DEFAULT_SETTINGS,
  type RecorderSettings,
} from '@rowing/telemetry-types';

const LS_KEY = 'rnz_recorder_settings_v1';

function withOriginDefaults(s: RecorderSettings): RecorderSettings {
  if (typeof window !== 'undefined' && window.location?.origin) {
    const origin = window.location.origin;
    if (!s.ingestUrl || s.ingestUrl === '/api/ingest') {
      s.ingestUrl = `${origin}/api/ingest`;
    }
  }
  return s;
}

export function loadSettings(): RecorderSettings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return withOriginDefaults({ ...DEFAULT_SETTINGS });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const { traccarUrl: _removed, ...rest } = parsed;
    return withOriginDefaults({ ...DEFAULT_SETTINGS, ...rest } as RecorderSettings);
  } catch {
    return withOriginDefaults({ ...DEFAULT_SETTINGS });
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
