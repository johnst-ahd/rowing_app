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

export type DerivedSample = {
  /** Strokes per minute from boat surge (15–50 when valid). */
  strokeRate?: number;
  /** Boat tipped past ~90° from session-start upright. */
  capsize?: boolean;
  /** Angle from calibrated upright (degrees). */
  tiltDeg?: number;
  /** Session alive ping (no GPS required). */
  heartbeat?: boolean;
  /** Device battery 0–100 (reported periodically). */
  batteryPct?: number;
};

export type TelemetrySample = {
  t: number;
  gps?: GpsSample;
  motion?: MotionSample;
  hr?: HrSample;
  derived?: DerivedSample;
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
  ingestUrl: string;
  ingestToken: string;
  gpsIntervalMs: number;
  motionIntervalMs: number;
  /** Min interval between motion-only upload samples (when GPS is off). */
  motionUploadIntervalMs: number;
  uploadBatchMs: number;
  enableGps: boolean;
  enableMotion: boolean;
  enableHr: boolean;
  /** Best-effort recording when screen locks or app is in background. */
  enableBackgroundRecording: boolean;
  /** Keep screen awake while recording (Screen Wake Lock API). */
  keepScreenOn: boolean;
};

/** Production ingest API (Vercel). Used as default on phones and new installs. */
export const DEFAULT_INGEST_URL =
  'https://rowing-app-recorder-pwa.vercel.app/api/ingest';

export const DEFAULT_SETTINGS: RecorderSettings = {
  deviceId: '',
  athleteId: '',
  ingestUrl: DEFAULT_INGEST_URL,
  ingestToken: '',
  gpsIntervalMs: 2000,
  motionIntervalMs: 50,
  motionUploadIntervalMs: 500,
  uploadBatchMs: 5000,
  enableGps: true,
  enableMotion: true,
  enableHr: true,
  enableBackgroundRecording: true,
  keepScreenOn: true,
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
