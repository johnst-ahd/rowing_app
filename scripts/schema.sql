-- RNZ rowing telemetry (Vercel Postgres / Neon)
-- Run once in SQL console or via Vercel Storage → Query

CREATE TABLE IF NOT EXISTS rnz_devices (
  id SERIAL PRIMARY KEY,
  unique_id TEXT NOT NULL UNIQUE,
  athlete_id TEXT,
  name TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rnz_sessions (
  session_id TEXT PRIMARY KEY,
  device_ref INTEGER NOT NULL REFERENCES rnz_devices(id),
  unique_id TEXT NOT NULL,
  athlete_id TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rnz_samples (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  device_ref INTEGER NOT NULL REFERENCES rnz_devices(id),
  unique_id TEXT NOT NULL,
  t_ms BIGINT NOT NULL,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  accuracy DOUBLE PRECISION,
  speed DOUBLE PRECISION,
  course DOUBLE PRECISION,
  compass_deg DOUBLE PRECISION,
  altitude DOUBLE PRECISION,
  hr INTEGER,
  ax DOUBLE PRECISION,
  ay DOUBLE PRECISION,
  az DOUBLE PRECISION
);

CREATE INDEX IF NOT EXISTS idx_rnz_samples_unique_time
  ON rnz_samples (unique_id, t_ms DESC);

CREATE INDEX IF NOT EXISTS idx_rnz_samples_device_ref_time
  ON rnz_samples (device_ref, t_ms DESC);

CREATE INDEX IF NOT EXISTS idx_rnz_samples_session_time
  ON rnz_samples (session_id, t_ms);

CREATE INDEX IF NOT EXISTS idx_rnz_sessions_unique_started
  ON rnz_sessions (unique_id, started_at DESC);

-- Magnetometer bow heading (optional; omitted on phones without compass hardware)
ALTER TABLE rnz_samples ADD COLUMN IF NOT EXISTS compass_deg DOUBLE PRECISION;
