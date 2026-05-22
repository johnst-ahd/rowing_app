/** Shared telemetry schemas for recorder PWA and ingest API. */

export type GpsSample = {
  lat: number;
  lon: number;
  acc?: number;
  spd?: number;
  hdg?: number;
  alt?: number;
};

export type MotionSample = {
  ax: number;
  ay: number;
  az: number;
};

export type HrSample = {
  bpm: number;
  contact?: boolean;
};

export type TelemetrySample = {
  t: number;
  gps?: GpsSample;
  motion?: MotionSample;
  hr?: HrSample;
};

export type TelemetryBatch = {
  sessionId: string;
  deviceId: string;
  athleteId?: string;
  samples: TelemetrySample[];
};

export type RecorderSettings = {
  deviceId: string;
  athleteId: string;
  traccarUrl: string;
  ingestUrl: string;
  ingestToken: string;
  gpsIntervalMs: number;
  motionIntervalMs: number;
  uploadBatchMs: number;
  enableGps: boolean;
  enableMotion: boolean;
  enableHr: boolean;
};

export const DEFAULT_SETTINGS: RecorderSettings = {
  deviceId: '',
  athleteId: '',
  traccarUrl: '',
  ingestUrl: '/api/ingest',
  ingestToken: '',
  gpsIntervalMs: 1000,
  motionIntervalMs: 50,
  uploadBatchMs: 5000,
  enableGps: true,
  enableMotion: true,
  enableHr: true,
};

export type SessionMeta = {
  sessionId: string;
  deviceId: string;
  athleteId: string;
  startedAt: number;
  endedAt?: number;
};

export type IngestResponse = {
  ok: boolean;
  received: number;
  sessionId?: string;
};
