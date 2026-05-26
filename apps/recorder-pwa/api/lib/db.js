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
  await sql`ALTER TABLE rnz_samples ADD COLUMN IF NOT EXISTS stroke_rate DOUBLE PRECISION`;
  await sql`ALTER TABLE rnz_samples ADD COLUMN IF NOT EXISTS capsize BOOLEAN`;
  await sql`ALTER TABLE rnz_samples ADD COLUMN IF NOT EXISTS tilt_deg DOUBLE PRECISION`;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_rnz_samples_unique_time
      ON rnz_samples (unique_id, t_ms DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_rnz_samples_device_ref_time
      ON rnz_samples (device_ref, t_ms DESC)
  `;

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
 * @param {Array<{ t: number, gps?: object, motion?: object, hr?: object, derived?: object }>} samples
 */
async function insertSamples(sessionId, deviceRef, uniqueId, samples) {
  const sql = await getSql();
  for (const s of samples) {
    const d = s.derived || {};
    await sql`
      INSERT INTO rnz_samples (
        session_id, device_ref, unique_id, t_ms,
        latitude, longitude, accuracy, speed, course, altitude,
        hr, ax, ay, az, stroke_rate, capsize, tilt_deg
      ) VALUES (
        ${sessionId},
        ${deviceRef},
        ${uniqueId},
        ${s.t},
        ${s.gps?.lat ?? null},
        ${s.gps?.lon ?? null},
        ${s.gps?.acc ?? null},
        ${s.gps?.spd ?? null},
        ${s.gps?.hdg ?? null},
        ${s.gps?.alt ?? null},
        ${s.hr?.bpm ?? null},
        ${s.motion?.ax ?? null},
        ${s.motion?.ay ?? null},
        ${s.motion?.az ?? null},
        ${d.strokeRate ?? null},
        ${d.capsize === true ? true : d.capsize === false ? false : null},
        ${d.tiltDeg ?? null}
      )
    `;
  }
}

async function persistBatch(sessionId, deviceId, athleteId, samples) {
  if (!hasDb() || !samples.length) return false;
  await initSchema();
  const dev = await ensureDevice(deviceId, athleteId);
  await upsertSession(sessionId, dev.id, deviceId, athleteId);
  await insertSamples(sessionId, dev.id, deviceId, samples);
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
    if (
      row.stroke_rate != null ||
      row.capsize != null ||
      row.tilt_deg != null
    ) {
      sample.derived = {
        strokeRate: row.stroke_rate != null ? Number(row.stroke_rate) : undefined,
        capsize: row.capsize === true,
        tiltDeg: row.tilt_deg != null ? Number(row.tilt_deg) : undefined,
      };
    }
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

async function getTraccarSnapshot(onlineMs = 120000) {
  const devices = await listRegistryDevices();
  const positions = await getLatestTraccarPositions(onlineMs);
  return { devices, positions, geofences: [], groups: [] };
}

async function listSessions(uniqueId, limit = 50) {
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
      stroke_rate, capsize, tilt_deg
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
      derived:
        s.stroke_rate != null || s.capsize != null || s.tilt_deg != null
          ? {
              strokeRate:
                s.stroke_rate != null ? Number(s.stroke_rate) : undefined,
              capsize: s.capsize === true,
              tiltDeg: s.tilt_deg != null ? Number(s.tilt_deg) : undefined,
            }
          : undefined,
    })),
  };
}

module.exports = {
  hasDb,
  initSchema,
  persistBatch,
  fetchRecentSamplesByDevice,
  getMapPositions,
  getTraccarSnapshot,
  getRoutePositions,
  resolveDevice,
  listRegistryDevices,
  listSessions,
  getSessionFromDb,
  getDashboardHistory,
  getDashboardHistoryBySession,
};
