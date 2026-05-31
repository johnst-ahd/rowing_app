/**
 * Postgres persistence for RNZ telemetry (Vercel Postgres / Neon).
 * Set POSTGRES_URL in Vercel. Falls back gracefully when unset.
 */

let schemaReady = false;

function hasDb() {
  return Boolean(
    process.env.POSTGRES_URL ||
      process.env.POSTGRES_URL_NON_POOLING ||
      process.env.DATABASE_URL,
  );
}

async function getSql() {
  if (!hasDb()) return null;
  const { sql } = await import('@vercel/postgres');
  return sql;
}

async function initSchema() {
  if (schemaReady || !hasDb()) return;
  const sql = await getSql();
  if (!sql) return;

  await sql`
    CREATE TABLE IF NOT EXISTS rnz_devices (
      id SERIAL PRIMARY KEY,
      unique_id TEXT NOT NULL UNIQUE,
      athlete_id TEXT,
      name TEXT NOT NULL,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS rnz_sessions (
      session_id TEXT PRIMARY KEY,
      device_ref INTEGER NOT NULL REFERENCES rnz_devices(id),
      unique_id TEXT NOT NULL,
      athlete_id TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
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
      altitude DOUBLE PRECISION,
      hr INTEGER,
      ax DOUBLE PRECISION,
      ay DOUBLE PRECISION,
      az DOUBLE PRECISION,
      stroke_rate DOUBLE PRECISION,
      capsize BOOLEAN,
      tilt_deg DOUBLE PRECISION
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS rnz_idempotency (
      key TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      response JSONB NOT NULL
    )
  `;
  await sql`ALTER TABLE rnz_samples ADD COLUMN IF NOT EXISTS stroke_rate DOUBLE PRECISION`;
  await sql`ALTER TABLE rnz_samples ADD COLUMN IF NOT EXISTS capsize BOOLEAN`;
  await sql`ALTER TABLE rnz_samples ADD COLUMN IF NOT EXISTS tilt_deg DOUBLE PRECISION`;
  await sql`ALTER TABLE rnz_samples ADD COLUMN IF NOT EXISTS battery_pct SMALLINT`;
  await sql`ALTER TABLE rnz_samples ADD COLUMN IF NOT EXISTS heartbeat BOOLEAN`;
  await sql`ALTER TABLE rnz_devices ADD COLUMN IF NOT EXISTS last_gps_t_ms BIGINT`;
  await sql`ALTER TABLE rnz_devices ADD COLUMN IF NOT EXISTS last_lat DOUBLE PRECISION`;
  await sql`ALTER TABLE rnz_devices ADD COLUMN IF NOT EXISTS last_lon DOUBLE PRECISION`;
  await sql`ALTER TABLE rnz_devices ADD COLUMN IF NOT EXISTS last_gps_accuracy DOUBLE PRECISION`;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_rnz_samples_unique_time
      ON rnz_samples (unique_id, t_ms DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_rnz_samples_gps_time
      ON rnz_samples (unique_id, t_ms DESC)
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_rnz_samples_device_ref_time
      ON rnz_samples (device_ref, t_ms DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_rnz_idempotency_created
      ON rnz_idempotency (created_at DESC)
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS rnz_geofences (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'boat_park',
      center_lat DOUBLE PRECISION NOT NULL,
      center_lon DOUBLE PRECISION NOT NULL,
      radius_m DOUBLE PRECISION NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      economy_gps_interval_sec DOUBLE PRECISION NOT NULL DEFAULT 30,
      economy_upload_interval_sec DOUBLE PRECISION NOT NULL DEFAULT 30,
      disable_capsize BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  if (!globalThis.__rnzRegistryGpsBackfill) {
    globalThis.__rnzRegistryGpsBackfill = true;
    await sql`
      UPDATE rnz_devices d
      SET last_gps_t_ms = s.t_ms,
          last_lat = s.latitude,
          last_lon = s.longitude,
          last_gps_accuracy = s.accuracy
      FROM (
        SELECT DISTINCT ON (unique_id)
          unique_id, t_ms, latitude, longitude, accuracy
        FROM rnz_samples
        WHERE latitude IS NOT NULL AND longitude IS NOT NULL
        ORDER BY unique_id, t_ms DESC
      ) s
      WHERE d.unique_id = s.unique_id
        AND (d.last_gps_t_ms IS NULL OR d.last_gps_t_ms < s.t_ms)
    `;
  }

  schemaReady = true;
}

/**
 * @returns {Promise<{ id: number, unique_id: string, athlete_id: string|null, name: string }>}
 */
async function ensureDevice(uniqueId, athleteId) {
  const sql = await getSql();
  await initSchema();
  const name = String(uniqueId);
  const rows = await sql`
    INSERT INTO rnz_devices (unique_id, athlete_id, name, last_seen_at)
    VALUES (${uniqueId}, ${athleteId || null}, ${name}, NOW())
    ON CONFLICT (unique_id) DO UPDATE SET
      last_seen_at = NOW(),
      athlete_id = COALESCE(EXCLUDED.athlete_id, rnz_devices.athlete_id)
    RETURNING id, unique_id, athlete_id, name
  `;
  return rows.rows[0];
}

async function upsertSession(sessionId, deviceRef, uniqueId, athleteId) {
  const sql = await getSql();
  await sql`
    INSERT INTO rnz_sessions (session_id, device_ref, unique_id, athlete_id, started_at, updated_at)
    VALUES (${sessionId}, ${deviceRef}, ${uniqueId}, ${athleteId || null}, NOW(), NOW())
    ON CONFLICT (session_id) DO UPDATE SET
      updated_at = NOW(),
      athlete_id = COALESCE(EXCLUDED.athlete_id, rnz_sessions.athlete_id)
  `;
}

/**
 * @param {import('@vercel/postgres').QueryResultRow} row
 */
function derivedFromRow(row) {
  /** @type {Record<string, unknown>} */
  const derived = {};
  if (row.stroke_rate != null) derived.strokeRate = Number(row.stroke_rate);
  if (row.capsize === true) derived.capsize = true;
  if (row.tilt_deg != null) derived.tiltDeg = Number(row.tilt_deg);
  if (row.battery_pct != null) derived.batteryPct = Number(row.battery_pct);
  if (row.heartbeat === true) derived.heartbeat = true;
  return Object.keys(derived).length ? derived : undefined;
}

/**
 * @param {Array<{ t: number, gps?: object, motion?: object, hr?: object, derived?: object }>} samples
 */
async function insertSamples(sessionId, deviceRef, uniqueId, samples) {
  const sql = await getSql();
  const packed = samples.map((s) => {
    const d = s.derived || {};
    return {
      t_ms: Number(s.t),
      latitude: s.gps?.lat ?? null,
      longitude: s.gps?.lon ?? null,
      accuracy: s.gps?.acc ?? null,
      speed: s.gps?.spd ?? null,
      course: s.gps?.hdg ?? null,
      altitude: s.gps?.alt ?? null,
      hr: s.hr?.bpm ?? null,
      ax: s.motion?.ax ?? null,
      ay: s.motion?.ay ?? null,
      az: s.motion?.az ?? null,
      stroke_rate: d.strokeRate ?? null,
      capsize: d.capsize === true ? true : d.capsize === false ? false : null,
      tilt_deg: d.tiltDeg ?? null,
      battery_pct:
        d.batteryPct != null && Number.isFinite(Number(d.batteryPct))
          ? Math.round(Number(d.batteryPct))
          : null,
      heartbeat: d.heartbeat === true ? true : null,
    };
  });
  await sql`
    INSERT INTO rnz_samples (
      session_id, device_ref, unique_id, t_ms,
      latitude, longitude, accuracy, speed, course, altitude,
      hr, ax, ay, az, stroke_rate, capsize, tilt_deg, battery_pct, heartbeat
    )
    SELECT
      ${sessionId}::text, ${deviceRef}::int, ${uniqueId}::text,
      x.t_ms, x.latitude, x.longitude, x.accuracy, x.speed, x.course, x.altitude,
      x.hr, x.ax, x.ay, x.az, x.stroke_rate, x.capsize, x.tilt_deg, x.battery_pct, x.heartbeat
    FROM jsonb_to_recordset(${JSON.stringify(packed)}::jsonb) AS x(
      t_ms bigint,
      latitude double precision,
      longitude double precision,
      accuracy double precision,
      speed double precision,
      course double precision,
      altitude double precision,
      hr integer,
      ax double precision,
      ay double precision,
      az double precision,
      stroke_rate double precision,
      capsize boolean,
      tilt_deg double precision,
      battery_pct smallint,
      heartbeat boolean
    )
  `;
}

/**
 * @param {Array<{ t: number, gps?: object }>} samples
 */
async function updateDeviceLatestGps(uniqueId, samples) {
  let best = null;
  for (const s of samples) {
    const lat = s.gps?.lat;
    const lon = s.gps?.lon;
    if (lat == null || lon == null) continue;
    const t = Number(s.t);
    if (!Number.isFinite(t)) continue;
    if (!best || t >= best.t) {
      best = {
        t,
        lat: Number(lat),
        lon: Number(lon),
        acc:
          s.gps?.acc != null && Number.isFinite(Number(s.gps.acc))
            ? Number(s.gps.acc)
            : null,
      };
    }
  }
  if (!best) return;
  const sql = await getSql();
  await sql`
    UPDATE rnz_devices
    SET last_gps_t_ms = ${best.t},
        last_lat = ${best.lat},
        last_lon = ${best.lon},
        last_gps_accuracy = ${best.acc}
    WHERE unique_id = ${String(uniqueId)}
      AND (last_gps_t_ms IS NULL OR last_gps_t_ms <= ${best.t})
  `;
}

async function persistBatch(sessionId, deviceId, athleteId, samples) {
  if (!hasDb() || !samples.length) return false;
  await initSchema();
  const dev = await ensureDevice(deviceId, athleteId);
  await upsertSession(sessionId, dev.id, deviceId, athleteId);
  await insertSamples(sessionId, dev.id, deviceId, samples);
  await updateDeviceLatestGps(deviceId, samples);
  return true;
}

async function resolveDevice(deviceIdParam, uniqueIdParam) {
  const sql = await getSql();
  await initSchema();
  if (uniqueIdParam) {
    const rows = await sql`
      SELECT id, unique_id, athlete_id, name FROM rnz_devices WHERE unique_id = ${uniqueIdParam} LIMIT 1
    `;
    return rows.rows[0] || null;
  }
  const n = Number(deviceIdParam);
  if (Number.isFinite(n)) {
    const rows = await sql`
      SELECT id, unique_id, athlete_id, name FROM rnz_devices WHERE id = ${n} LIMIT 1
    `;
    return rows.rows[0] || null;
  }
  return null;
}

function rowToTraccarPosition(row) {
  const fix = new Date(Number(row.t_ms)).toISOString();
  const attrs = {};
  if (row.hr != null) {
    attrs.hr = row.hr;
    attrs.heartRate = row.hr;
  }
  if (row.ax != null) {
    attrs.ax = row.ax;
    attrs.ay = row.ay;
    attrs.az = row.az;
  }
  if (row.stroke_rate != null) attrs.strokeRate = Number(row.stroke_rate);
  if (row.capsize === true) attrs.capsize = true;
  if (row.tilt_deg != null) attrs.tiltDeg = Number(row.tilt_deg);
  if (row.battery_pct != null) attrs.batteryPct = Number(row.battery_pct);
  if (row.heartbeat === true) attrs.heartbeat = true;
  return {
    id: Number(row.id),
    deviceId: Number(row.device_ref),
    latitude: row.latitude,
    longitude: row.longitude,
    altitude: row.altitude ?? 0,
    speed: row.speed ?? 0,
    course: row.course ?? 0,
    accuracy: row.accuracy ?? 0,
    fixTime: fix,
    deviceTime: fix,
    serverTime: fix,
    attributes: attrs,
    deviceName: row.unique_id,
  };
}

async function getRoutePositions(deviceRef, fromIso, toIso) {
  const sql = await getSql();
  const fromMs = new Date(fromIso).getTime();
  const toMs = new Date(toIso).getTime();
  const rows = await sql`
    SELECT id, device_ref, unique_id, t_ms, latitude, longitude, accuracy, speed, course, altitude, hr, ax, ay, az,
      stroke_rate, capsize, tilt_deg
    FROM rnz_samples
    WHERE device_ref = ${deviceRef}
      AND t_ms >= ${fromMs}
      AND t_ms <= ${toMs}
      AND latitude IS NOT NULL
      AND longitude IS NOT NULL
    ORDER BY t_ms ASC
    LIMIT 50000
  `;
  return rows.rows.map(rowToTraccarPosition);
}

async function getLatestTraccarPositions(onlineMs = 30000) {
  const sql = await getSql();
  const cutoff = Date.now() - onlineMs;
  const rows = await sql`
    SELECT DISTINCT ON (s.device_ref)
      s.id, s.device_ref, s.unique_id, s.t_ms, s.latitude, s.longitude, s.accuracy, s.speed, s.course, s.altitude, s.hr, s.ax, s.ay, s.az,
      d.last_seen_at
    FROM rnz_samples s
    JOIN rnz_devices d ON d.id = s.device_ref
    WHERE s.latitude IS NOT NULL AND s.longitude IS NOT NULL
    ORDER BY s.device_ref, s.t_ms DESC
  `;
  return rows.rows.map(rowToTraccarPosition);
}

/**
 * Recent samples grouped by device (for dashboard when Postgres is enabled).
 * @returns {Promise<Map<string, { deviceId: string, athleteId: string|null, sessionId: string, samples: object[], lastSeenMs: number, firstSeenMs: number }>>}
 */
async function fetchRecentSamplesByDevice(windowMs) {
  const sql = await getSql();
  await initSchema();
  const cutoff = Date.now() - windowMs;
  const rows = await sql`
    SELECT s.unique_id, s.session_id, s.t_ms,
      s.latitude, s.longitude, s.accuracy, s.speed, s.course, s.altitude,
      s.hr, s.ax, s.ay, s.az, s.stroke_rate, s.capsize, s.tilt_deg,
      s.battery_pct, s.heartbeat,
      d.athlete_id
    FROM rnz_samples s
    LEFT JOIN rnz_devices d ON d.unique_id = s.unique_id
    WHERE s.t_ms >= ${cutoff}
    ORDER BY s.unique_id, s.t_ms ASC
    LIMIT 80000
  `;

  /** @type {Map<string, object>} */
  const byDevice = new Map();
  for (const row of rows.rows) {
    const uid = String(row.unique_id);
    let entry = byDevice.get(uid);
    const t = Number(row.t_ms);
    const sample = {
      t,
      gps:
        row.latitude != null
          ? {
              lat: row.latitude,
              lon: row.longitude,
              acc: row.accuracy,
              spd: row.speed,
              hdg: row.course,
              alt: row.altitude,
            }
          : undefined,
      hr: row.hr != null ? { bpm: row.hr } : undefined,
      motion:
        row.ax != null ? { ax: row.ax, ay: row.ay, az: row.az } : undefined,
    };
    const derived = derivedFromRow(row);
    if (derived) sample.derived = derived;
    if (!entry) {
      entry = {
        deviceId: uid,
        athleteId: row.athlete_id || null,
        sessionId: String(row.session_id),
        samples: [],
        lastSeenMs: t,
        firstSeenMs: t,
      };
      byDevice.set(uid, entry);
    }
    entry.samples.push(sample);
    if (t >= entry.lastSeenMs) {
      entry.lastSeenMs = t;
      entry.sessionId = String(row.session_id);
    }
    if (t < entry.firstSeenMs) entry.firstSeenMs = t;
    if (row.athlete_id) entry.athleteId = row.athlete_id;
  }
  return byDevice;
}

/**
 * Latest GPS fix per device from registry (one row read — works across serverless instances).
 */
async function getRegistryMapPositions(onlineMs, staleMs) {
  const sql = await getSql();
  await initSchema();
  const now = Date.now();
  const staleCutoff = now - staleMs;
  const rows = await sql`
    SELECT unique_id, athlete_id, last_seen_at,
      last_gps_t_ms, last_lat, last_lon, last_gps_accuracy
    FROM rnz_devices
    WHERE last_gps_t_ms IS NOT NULL
      AND last_lat IS NOT NULL
      AND last_lon IS NOT NULL
      AND last_gps_t_ms >= ${staleCutoff}
  `;
  return rows.rows.map((row) => {
    const fixMs = Number(row.last_gps_t_ms);
    const lastSeenMs = Math.max(
      fixMs,
      new Date(row.last_seen_at).getTime(),
    );
    return {
      deviceId: String(row.unique_id),
      athleteId: row.athlete_id || null,
      latitude: row.last_lat,
      longitude: row.last_lon,
      accuracy: row.last_gps_accuracy,
      fixMs,
      fixAgeSec: Math.round((now - fixMs) / 1000),
      lastSeenAgoSec: Math.round((now - lastSeenMs) / 1000),
      online: now - lastSeenMs <= onlineMs,
      hr: null,
    };
  });
}

/**
 * Latest GPS fix per device for dashboard map (within stale window).
 */
async function getMapPositions(onlineMs, staleMs) {
  const sql = await getSql();
  await initSchema();
  const now = Date.now();
  const staleCutoff = now - staleMs;
  const rows = await sql`
    SELECT DISTINCT ON (s.unique_id)
      s.unique_id, s.latitude, s.longitude, s.accuracy, s.t_ms, s.hr,
      d.last_seen_at, d.athlete_id
    FROM rnz_samples s
    JOIN rnz_devices d ON d.unique_id = s.unique_id
    WHERE s.latitude IS NOT NULL AND s.longitude IS NOT NULL
      AND s.t_ms >= ${staleCutoff}
    ORDER BY s.unique_id, s.t_ms DESC
  `;
  return rows.rows.map((row) => {
    const fixMs = Number(row.t_ms);
    const lastSeenMs = Math.max(
      fixMs,
      new Date(row.last_seen_at).getTime(),
    );
    return {
      deviceId: String(row.unique_id),
      athleteId: row.athlete_id || null,
      latitude: row.latitude,
      longitude: row.longitude,
      accuracy: row.accuracy,
      fixMs,
      fixAgeSec: Math.round((now - fixMs) / 1000),
      lastSeenAgoSec: Math.round((now - lastSeenMs) / 1000),
      online: now - lastSeenMs <= onlineMs,
      hr: row.hr,
    };
  });
}

/** @returns {Promise<Map<string, { t: number, lat: number, lon: number, acc: number|null }>>} */
async function getRegistryGpsByDevice() {
  const sql = await getSql();
  await initSchema();
  const rows = await sql`
    SELECT unique_id, last_gps_t_ms, last_lat, last_lon, last_gps_accuracy
    FROM rnz_devices
    WHERE last_gps_t_ms IS NOT NULL
      AND last_lat IS NOT NULL
      AND last_lon IS NOT NULL
  `;
  /** @type {Map<string, { t: number, lat: number, lon: number, acc: number|null }>} */
  const byDevice = new Map();
  for (const row of rows.rows) {
    byDevice.set(String(row.unique_id), {
      t: Number(row.last_gps_t_ms),
      lat: row.last_lat,
      lon: row.last_lon,
      acc: row.last_gps_accuracy,
    });
  }
  return byDevice;
}

async function listRegistryDevices() {
  const sql = await getSql();
  const rows = await sql`
    SELECT id, unique_id, athlete_id, name, first_seen_at, last_seen_at
    FROM rnz_devices
    ORDER BY last_seen_at DESC
  `;
  return rows.rows.map((d) => ({
    id: Number(d.id),
    name: d.name || d.unique_id,
    uniqueId: d.unique_id,
    status: 'online',
    lastUpdate: d.last_seen_at,
    disabled: false,
    attributes: {
      athleteId: d.athlete_id || '',
      uniqueId: d.unique_id,
    },
  }));
}

/** Devices with sample time range (for dashboard history — not limited to live poll). */
async function listHistoryDevicesDetailed() {
  const sql = await getSql();
  await initSchema();
  const rows = await sql`
    SELECT d.unique_id, d.name, d.last_seen_at,
      MIN(s.t_ms)::bigint AS first_sample_ms,
      MAX(s.t_ms)::bigint AS last_sample_ms,
      COUNT(s.id)::int AS sample_count
    FROM rnz_devices d
    INNER JOIN rnz_samples s ON s.unique_id = d.unique_id
    GROUP BY d.id, d.unique_id, d.name, d.last_seen_at
    ORDER BY MAX(s.t_ms) DESC
  `;
  return rows.rows.map((r) => ({
    uniqueId: String(r.unique_id),
    name: r.name || r.unique_id,
    lastUpdate: r.last_seen_at,
    firstSampleMs: Number(r.first_sample_ms),
    lastSampleMs: Number(r.last_sample_ms),
    sampleCount: Number(r.sample_count),
  }));
}

async function getTraccarSnapshot(onlineMs = 120000) {
  const devices = await listRegistryDevices();
  const positions = await getLatestTraccarPositions(onlineMs);
  return { devices, positions, geofences: [], groups: [] };
}

async function listSessions(uniqueId, limit = 100) {
  const sql = await getSql();
  const rows = uniqueId
    ? await sql`
        SELECT session_id, unique_id, athlete_id, started_at, ended_at, updated_at,
          (SELECT COUNT(*)::int FROM rnz_samples WHERE session_id = rnz_sessions.session_id) AS sample_count
        FROM rnz_sessions
        WHERE unique_id = ${uniqueId}
        ORDER BY started_at DESC
        LIMIT ${limit}
      `
    : await sql`
        SELECT session_id, unique_id, athlete_id, started_at, ended_at, updated_at,
          (SELECT COUNT(*)::int FROM rnz_samples WHERE session_id = rnz_sessions.session_id) AS sample_count
        FROM rnz_sessions
        ORDER BY started_at DESC
        LIMIT ${limit}
      `;
  return rows.rows;
}

/**
 * @param {import('@vercel/postgres').QueryResultRow[]} rows
 */
function buildDashboardHistoryFromRows(rows, meta = {}) {
  /** @type {object[]} */
  const track = [];
  /** @type {object[]} */
  const capsizeEvents = [];
  let gpsCount = 0;

  for (const row of rows) {
    const t = Number(row.t_ms);
    const hasGps = row.latitude != null && row.longitude != null;
    if (hasGps) gpsCount++;
    track.push({
      t,
      lat: hasGps ? row.latitude : null,
      lon: hasGps ? row.longitude : null,
      speed: row.speed != null ? Number(row.speed) : null,
      hr: row.hr != null ? Number(row.hr) : null,
      strokeRate:
        row.stroke_rate != null ? Number(row.stroke_rate) : null,
      capsize: row.capsize === true,
      tiltDeg: row.tilt_deg != null ? Number(row.tilt_deg) : null,
    });
    if (row.capsize === true && hasGps) {
      capsizeEvents.push({
        t,
        lat: row.latitude,
        lon: row.longitude,
        tiltDeg: row.tilt_deg != null ? Number(row.tilt_deg) : null,
      });
    }
  }

  /** Collapse rapid capsize samples into incidents (~60s). */
  const incidents = [];
  for (const ev of capsizeEvents) {
    const prev = incidents[incidents.length - 1];
    if (prev && ev.t - prev.t < 60000) continue;
    incidents.push(ev);
  }

  const MAX_TRACK_POINTS = 4000;
  let trackOut = track;
  let downsampled = false;
  if (track.length > MAX_TRACK_POINTS) {
    const step = Math.ceil(track.length / MAX_TRACK_POINTS);
    trackOut = [];
    for (let i = 0; i < track.length; i += step) trackOut.push(track[i]);
    if (trackOut[trackOut.length - 1] !== track[track.length - 1]) {
      trackOut.push(track[track.length - 1]);
    }
    downsampled = true;
  }

  return {
    ...meta,
    track: trackOut,
    capsizeEvents: incidents,
    capsizeSampleCount: capsizeEvents.length,
    pointCount: track.length,
    gpsCount,
    downsampled,
  };
}

async function getDashboardHistory(uniqueId, fromIso, toIso) {
  if (!hasDb()) return null;
  const sql = await getSql();
  await initSchema();
  const fromMs = new Date(fromIso).getTime();
  const toMs = new Date(toIso).getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;

  const rows = await sql`
    SELECT t_ms, latitude, longitude, speed, hr, stroke_rate, capsize, tilt_deg
    FROM rnz_samples
    WHERE unique_id = ${String(uniqueId)}
      AND t_ms >= ${fromMs}
      AND t_ms <= ${toMs}
    ORDER BY t_ms ASC
    LIMIT 50000
  `;

  return buildDashboardHistoryFromRows(rows.rows, {
    uniqueId: String(uniqueId),
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
  });
}

async function getDashboardHistoryBySession(sessionId) {
  if (!hasDb()) return null;
  const sql = await getSql();
  await initSchema();
  const meta = await sql`
    SELECT session_id, unique_id, athlete_id, started_at, ended_at
    FROM rnz_sessions
    WHERE session_id = ${String(sessionId)}
    LIMIT 1
  `;
  if (!meta.rows[0]) return null;
  const row = meta.rows[0];
  const samples = await sql`
    SELECT t_ms, latitude, longitude, speed, hr, stroke_rate, capsize, tilt_deg
    FROM rnz_samples
    WHERE session_id = ${String(sessionId)}
    ORDER BY t_ms ASC
    LIMIT 50000
  `;
  const fromMs = samples.rows.length
    ? Number(samples.rows[0].t_ms)
    : new Date(row.started_at).getTime();
  const toMs = samples.rows.length
    ? Number(samples.rows[samples.rows.length - 1].t_ms)
    : new Date(row.ended_at || row.started_at).getTime();

  return buildDashboardHistoryFromRows(samples.rows, {
    sessionId: row.session_id,
    uniqueId: row.unique_id,
    athleteId: row.athlete_id || null,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
  });
}

async function getSessionFromDb(sessionId) {
  const sql = await getSql();
  const meta = await sql`
    SELECT * FROM rnz_sessions WHERE session_id = ${sessionId} LIMIT 1
  `;
  if (!meta.rows[0]) return null;
  const samples = await sql`
    SELECT t_ms AS t, latitude, longitude, accuracy, speed, course, altitude, hr, ax, ay, az,
      stroke_rate, capsize, tilt_deg, battery_pct, heartbeat
    FROM rnz_samples
    WHERE session_id = ${sessionId}
    ORDER BY t_ms ASC
    LIMIT 50000
  `;
  const row = meta.rows[0];
  return {
    sessionId: row.session_id,
    deviceId: row.unique_id,
    athleteId: row.athlete_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    samples: samples.rows.map((s) => ({
      t: Number(s.t),
      gps:
        s.latitude != null
          ? {
              lat: s.latitude,
              lon: s.longitude,
              acc: s.accuracy,
              spd: s.speed,
              hdg: s.course,
              alt: s.altitude,
            }
          : undefined,
      hr: s.hr != null ? { bpm: s.hr } : undefined,
      motion:
        s.ax != null
          ? { ax: s.ax, ay: s.ay, az: s.az }
          : undefined,
      derived: derivedFromRow(s),
    })),
  };
}

async function getStorageStats() {
  if (!hasDb()) return null;
  const sql = await getSql();
  await initSchema();
  const fromEnv =
    process.env.POSTGRES_STORAGE_LIMIT_MB ?? process.env.STORAGE_LIMIT_MB;
  const parsed =
    fromEnv != null && String(fromEnv).trim() !== '' ? Number(fromEnv) : NaN;
  const limitMb =
    Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 512;
  const result = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM rnz_devices) AS device_count,
      (SELECT COUNT(*)::int FROM rnz_sessions) AS session_count,
      (SELECT COUNT(*)::int FROM rnz_samples) AS sample_count,
      (SELECT MIN(t_ms)::bigint FROM rnz_samples) AS oldest_sample_ms,
      (SELECT MAX(t_ms)::bigint FROM rnz_samples) AS newest_sample_ms,
      pg_database_size(current_database())::bigint AS database_size_bytes,
      pg_total_relation_size('rnz_samples')::bigint AS samples_table_bytes
  `;
  const r = result.rows[0];
  const usedBytes =
    r.database_size_bytes != null ? Number(r.database_size_bytes) : null;
  const limitBytes =
    limitMb != null && Number.isFinite(limitMb) && limitMb > 0
      ? Math.round(limitMb * 1024 * 1024)
      : null;
  return {
    deviceCount: Number(r.device_count) || 0,
    sessionCount: Number(r.session_count) || 0,
    sampleCount: Number(r.sample_count) || 0,
    oldestSampleMs:
      r.oldest_sample_ms != null ? Number(r.oldest_sample_ms) : null,
    newestSampleMs:
      r.newest_sample_ms != null ? Number(r.newest_sample_ms) : null,
    usedBytes,
    samplesTableBytes:
      r.samples_table_bytes != null ? Number(r.samples_table_bytes) : null,
    storageLimitBytes: limitBytes,
    storageUsedPct:
      usedBytes != null && limitBytes != null && limitBytes > 0
        ? Math.round((usedBytes / limitBytes) * 1000) / 10
        : null,
  };
}

async function deleteSession(sessionId) {
  if (!hasDb()) return null;
  const sql = await getSql();
  await initSchema();
  const sid = String(sessionId);
  const delSamples = await sql`
    DELETE FROM rnz_samples WHERE session_id = ${sid}
  `;
  const delSession = await sql`
    DELETE FROM rnz_sessions WHERE session_id = ${sid}
  `;
  return {
    samplesDeleted: delSamples.rowCount ?? 0,
    sessionsDeleted: delSession.rowCount ?? 0,
  };
}

async function deleteDeviceData(uniqueId) {
  if (!hasDb()) return null;
  const sql = await getSql();
  await initSchema();
  const uid = String(uniqueId);
  const delSamples = await sql`
    DELETE FROM rnz_samples WHERE unique_id = ${uid}
  `;
  const delSessions = await sql`
    DELETE FROM rnz_sessions WHERE unique_id = ${uid}
  `;
  const delDevice = await sql`
    DELETE FROM rnz_devices WHERE unique_id = ${uid}
  `;
  return {
    samplesDeleted: delSamples.rowCount ?? 0,
    sessionsDeleted: delSessions.rowCount ?? 0,
    devicesDeleted: delDevice.rowCount ?? 0,
  };
}

async function deleteSamplesInRange(uniqueId, fromMs, toMs) {
  if (!hasDb()) return null;
  const sql = await getSql();
  await initSchema();
  const uid = String(uniqueId);
  const delSamples = await sql`
    DELETE FROM rnz_samples
    WHERE unique_id = ${uid}
      AND t_ms >= ${fromMs}
      AND t_ms <= ${toMs}
  `;
  const delEmptySessions = await sql`
    DELETE FROM rnz_sessions s
    WHERE s.unique_id = ${uid}
      AND NOT EXISTS (
        SELECT 1 FROM rnz_samples x WHERE x.session_id = s.session_id
      )
  `;
  return {
    samplesDeleted: delSamples.rowCount ?? 0,
    sessionsDeleted: delEmptySessions.rowCount ?? 0,
  };
}

async function deleteAllStoredData() {
  if (!hasDb()) return null;
  const sql = await getSql();
  await initSchema();
  const delSamples = await sql`DELETE FROM rnz_samples`;
  const delSessions = await sql`DELETE FROM rnz_sessions`;
  const delDevices = await sql`DELETE FROM rnz_devices`;
  return {
    samplesDeleted: delSamples.rowCount ?? 0,
    sessionsDeleted: delSessions.rowCount ?? 0,
    devicesDeleted: delDevices.rowCount ?? 0,
  };
}

async function getIdempotency(key, ttlMs = 10 * 60 * 1000) {
  if (!hasDb()) return null;
  const sql = await getSql();
  await initSchema();
  const rows = await sql`
    SELECT response, created_at
    FROM rnz_idempotency
    WHERE key = ${String(key)}
    LIMIT 1
  `;
  const row = rows.rows[0];
  if (!row) return null;
  const createdMs = new Date(row.created_at).getTime();
  if (!Number.isFinite(createdMs) || Date.now() - createdMs > ttlMs) return null;
  return row.response || null;
}

async function setIdempotency(key, response) {
  if (!hasDb()) return;
  const sql = await getSql();
  await initSchema();
  await sql`
    INSERT INTO rnz_idempotency (key, created_at, response)
    VALUES (${String(key)}, NOW(), ${JSON.stringify(response)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET
      created_at = NOW(),
      response = EXCLUDED.response
  `;
  await sql`
    DELETE FROM rnz_idempotency
    WHERE created_at < NOW() - INTERVAL '30 minutes'
  `;
}

const { normalizeGeofence } = require('./geofence');

async function listGeofences() {
  if (!hasDb()) return [];
  const sql = await getSql();
  await initSchema();
  const rows = await sql`
    SELECT id, name, kind, center_lat, center_lon, radius_m, enabled,
           economy_gps_interval_sec, economy_upload_interval_sec, disable_capsize,
           created_at, updated_at
    FROM rnz_geofences
    ORDER BY name ASC
  `;
  return rows.rows.map(normalizeGeofence);
}

async function createGeofence(body) {
  if (!hasDb()) return null;
  const sql = await getSql();
  await initSchema();
  const name = String(body.name ?? '').trim();
  const centerLat = Number(body.centerLat);
  const centerLon = Number(body.centerLon);
  const radiusM = Number(body.radiusM);
  if (!name) throw new Error('name is required');
  if (!Number.isFinite(centerLat) || !Number.isFinite(centerLon)) {
    throw new Error('centerLat and centerLon are required');
  }
  if (!Number.isFinite(radiusM) || radiusM <= 0) {
    throw new Error('radiusM must be a positive number');
  }
  const kind = String(body.kind ?? 'boat_park').trim() || 'boat_park';
  const economyGps = Math.max(5, Number(body.economyGpsIntervalSec) || 30);
  const economyUpload = Math.max(5, Number(body.economyUploadIntervalSec) || 30);
  const disableCapsize = body.disableCapsize !== false;
  const enabled = body.enabled !== false;
  const rows = await sql`
    INSERT INTO rnz_geofences (
      name, kind, center_lat, center_lon, radius_m, enabled,
      economy_gps_interval_sec, economy_upload_interval_sec, disable_capsize
    )
    VALUES (
      ${name}, ${kind}, ${centerLat}, ${centerLon}, ${radiusM}, ${enabled},
      ${economyGps}, ${economyUpload}, ${disableCapsize}
    )
    RETURNING id, name, kind, center_lat, center_lon, radius_m, enabled,
              economy_gps_interval_sec, economy_upload_interval_sec, disable_capsize,
              created_at, updated_at
  `;
  return normalizeGeofence(rows.rows[0]);
}

async function deleteGeofence(id) {
  if (!hasDb()) return false;
  const sql = await getSql();
  await initSchema();
  const n = Number(id);
  if (!Number.isFinite(n)) return false;
  const del = await sql`DELETE FROM rnz_geofences WHERE id = ${n}`;
  return (del.rowCount ?? 0) > 0;
}

module.exports = {
  hasDb,
  initSchema,
  persistBatch,
  fetchRecentSamplesByDevice,
  getMapPositions,
  getRegistryMapPositions,
  getRegistryGpsByDevice,
  getTraccarSnapshot,
  getRoutePositions,
  resolveDevice,
  listRegistryDevices,
  listHistoryDevicesDetailed,
  listSessions,
  getSessionFromDb,
  getDashboardHistory,
  getDashboardHistoryBySession,
  getStorageStats,
  deleteSession,
  deleteDeviceData,
  deleteSamplesInRange,
  deleteAllStoredData,
  getIdempotency,
  setIdempotency,
  listGeofences,
  createGeofence,
  deleteGeofence,
};
