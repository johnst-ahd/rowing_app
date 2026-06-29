import { authHeaders, type CoachSettings } from './settings';

export type FleetDevice = {
  deviceId: string;
  online?: boolean;
  gps?: boolean;
  lastSeenAgoSec?: number;
  rowing?: {
    strokeRate?: number | null;
    strokeRateValid?: boolean;
    capsize?: boolean;
  };
  gpsLast?: {
    lat?: number;
    lon?: number;
    speed?: number;
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
};

export async function fetchDevices(settings: CoachSettings): Promise<FleetDevice[]> {
  const url = `${settings.apiBaseUrl.replace(/\/$/, '')}/api/devices?windowSec=60&onlineSec=120`;
  const res = await fetch(url, { headers: authHeaders(settings) });
  if (!res.ok) {
    throw new Error(`Devices ${res.status}`);
  }
  const data = (await res.json()) as { devices?: FleetDevice[] };
  return data.devices ?? [];
}

export async function fetchMapPositions(settings: CoachSettings): Promise<MapPosition[]> {
  const url = `${settings.apiBaseUrl.replace(/\/$/, '')}/api/positions?onlineSec=120`;
  const res = await fetch(url, { headers: authHeaders(settings) });
  if (!res.ok) {
    throw new Error(`Positions ${res.status}`);
  }
  const data = (await res.json()) as { positions?: MapPosition[] };
  return (data.positions ?? []).filter(
    (p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude),
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
  const base = settings.apiBaseUrl.replace(/\/$/, '');
  const url = `${base}/api/history?list=sessions&uniqueId=${encodeURIComponent(deviceId)}`;
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
  const base = settings.apiBaseUrl.replace(/\/$/, '');
  const url = `${base}/api/history?format=dashboard&sessionId=${encodeURIComponent(sessionId)}`;
  const res = await fetch(url, { headers: authHeaders(settings) });
  if (!res.ok) throw new Error(`History ${res.status}`);
  const data = (await res.json()) as { track?: HistoryPoint[] };
  return data.track ?? [];
}
