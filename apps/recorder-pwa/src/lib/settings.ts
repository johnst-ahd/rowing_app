import {
  DEFAULT_INGEST_URL,
  DEFAULT_SETTINGS,
  type RecorderSettings,
} from '@rowing/telemetry-types';
import { normalizeIngestUrl } from '../upload/telemetry-api';

const LS_KEY = 'rnz_recorder_settings_v1';

const IS_NATIVE_APP = import.meta.env.VITE_PLATFORM === 'native';

function isLocalDevOrigin(origin: string): boolean {
  if (IS_NATIVE_APP) return false;
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return false;
  }
}

/** Capacitor WebView uses https://localhost — that is not a reachable ingest server. */
function isBrokenNativeIngestUrl(url: string): boolean {
  if (!IS_NATIVE_APP) return false;
  try {
    const u = new URL(url.trim());
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function needsIngestUrlDefault(url: string): boolean {
  const u = url.trim();
  if (!u) return true;
  if (u === '/api/ingest') return true;
  return false;
}

function withOriginDefaults(s: RecorderSettings): RecorderSettings {
  if (needsIngestUrlDefault(s.ingestUrl)) {
    if (typeof window !== 'undefined' && window.location?.origin) {
      const origin = window.location.origin;
      s.ingestUrl = isLocalDevOrigin(origin)
        ? `${origin}/api/ingest`
        : DEFAULT_INGEST_URL;
    } else {
      s.ingestUrl = DEFAULT_INGEST_URL;
    }
  }
  s.ingestUrl = normalizeIngestUrl(s.ingestUrl);
  return s;
}

export function loadSettings(): RecorderSettings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return withOriginDefaults({ ...DEFAULT_SETTINGS });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const { traccarUrl: _removed, ...rest } = parsed;
    const merged = withOriginDefaults({
      ...DEFAULT_SETTINGS,
      ...rest,
    } as RecorderSettings);
    if (isBrokenNativeIngestUrl(merged.ingestUrl)) {
      merged.ingestUrl = DEFAULT_INGEST_URL;
      saveSettings(merged);
    }
    return merged;
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
  return withOriginDefaults({
    deviceId: String(fd.get('deviceId') ?? '').trim(),
    athleteId: String(fd.get('athleteId') ?? '').trim(),
    ingestUrl: String(fd.get('ingestUrl') ?? DEFAULT_INGEST_URL).trim(),
    ingestToken: String(fd.get('ingestToken') ?? '').trim(),
    gpsIntervalMs: num('gpsIntervalMs', DEFAULT_SETTINGS.gpsIntervalMs),
    motionIntervalMs: num('motionIntervalMs', DEFAULT_SETTINGS.motionIntervalMs),
    motionUploadIntervalMs: num(
      'motionUploadIntervalMs',
      DEFAULT_SETTINGS.motionUploadIntervalMs,
    ),
    uploadBatchMs: num('uploadBatchMs', DEFAULT_SETTINGS.uploadBatchMs),
    enableGps: fd.get('enableGps') === 'on',
    enableMotion: fd.get('enableMotion') === 'on',
    enableHr: fd.get('enableHr') === 'on',
    enableBackgroundRecording: fd.get('enableBackgroundRecording') === 'on',
    keepScreenOn: fd.get('keepScreenOn') === 'on',
  });
}
