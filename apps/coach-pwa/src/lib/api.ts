import { authHeaders, type CoachSettings } from './settings';

export type FleetDevice = {
  deviceId: string;
  online?: boolean;
  lastSeenAgoSec?: number;
  gps?: { ageSec?: number | null; present?: boolean };
  /** Resolved GPS fix age (map + API). */
  gpsAgeSec?: number;
  rowing?: {
    strokeRate?: number | null;
    strokeRateValid?: boolean;
    capsize?: boolean;
  };
};

export type MapPosition = {
  deviceId: string;
  latitude: number;
  longitude: number;
  speed?: number | null;
  strokeRate?: number | null;
  capsize?: boolean;
  fixAgeSec?: number;
  lastSeenAgoSec?: number;
};

function apiBase(settings: CoachSettings): string {
  return String(settings.apiBaseUrl ?? '').replace(/\/$/, '');
}

export async function fetchDevices(settings: CoachSettings): Promise<FleetDevice[]> {
  const url = `${apiBase(settings)}/api/devices?windowSec=60&onlineSec=120`;
  const res = await fetch(url, { headers: authHeaders(settings) });
  if (!res.ok) {
    throw new Error(`Devices ${res.status}`);
  }
  const data = (await res.json()) as { devices?: FleetDevice[] };
  return (data.devices ?? []).map((d) => ({
    ...d,
    deviceId: String(d.deviceId ?? ''),
  }));
}

export async function fetchMapPositions(settings: CoachSettings): Promise<MapPosition[]> {
  const url = `${apiBase(settings)}/api/map-positions?onlineSec=120&staleSec=3600`;
  const res = await fetch(url, { headers: authHeaders(settings) });
  if (!res.ok) {
    throw new Error(`Map ${res.status}`);
  }
  const data = (await res.json()) as { positions?: MapPosition[] };
  return (data.positions ?? [])
    .map((p) => ({
      ...p,
      deviceId: String(p.deviceId ?? ''),
    }))
    .filter(
      (p) => p.deviceId && Number.isFinite(p.latitude) && Number.isFinite(p.longitude),
    );
}

export type SessionSummary = {
  session_id: string;
  unique_id: string;
  started_at: string;
  ended_at?: string | null;
  sample_count?: number;
};

export async function listSessions(
  settings: CoachSettings,
  deviceId: string,
): Promise<SessionSummary[]> {
  const url = `${apiBase(settings)}/api/history?list=sessions&uniqueId=${encodeURIComponent(deviceId)}`;
  const res = await fetch(url, { headers: authHeaders(settings) });
  if (!res.ok) throw new Error(`Sessions ${res.status}`);
  const data = (await res.json()) as { sessions?: SessionSummary[] };
  return data.sessions ?? [];
}

export type HistoryPoint = {
  t: number;
  lat?: number;
  lon?: number;
  speed?: number;
  strokeRate?: number;
  capsize?: boolean;
};

export async function loadSessionTrack(
  settings: CoachSettings,
  sessionId: string,
): Promise<HistoryPoint[]> {
  const url = `${apiBase(settings)}/api/history?format=dashboard&sessionId=${encodeURIComponent(sessionId)}`;
  const res = await fetch(url, { headers: authHeaders(settings) });
  if (!res.ok) throw new Error(`History ${res.status}`);
  const data = (await res.json()) as { track?: HistoryPoint[] };
  return data.track ?? [];
}
