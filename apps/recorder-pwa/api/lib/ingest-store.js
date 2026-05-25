const db = require('./db');
const { analyzeMotionWindow } = require('./motion-analysis');

const MAX_SAMPLES_PER_REQUEST = 500;
const MAX_SESSIONS = 200;
const MAX_SAMPLES_PER_SESSION = 50000;
const RING_TRIM_TO = 3000;

/** @type {Map<string, SessionRow>} */
const sessions = globalThis.__rnzIngestSessions ?? new Map();
globalThis.__rnzIngestSessions = sessions;

/** Monitor dismissed capsize per device (timestamp); ignores older capsize samples. */
/** @type {Map<string, number>} */
const capsizeClearAt = globalThis.__rnzCapsizeClearAt ?? new Map();
globalThis.__rnzCapsizeClearAt = capsizeClearAt;

function getCapsizeClearAt(deviceId) {
  if (!deviceId) return null;
  return capsizeClearAt.get(String(deviceId)) ?? null;
}

function setCapsizeClear(deviceId) {
  capsizeClearAt.set(String(deviceId), Date.now());
}

/**
 * @typedef {{ t: number, gps?: object, motion?: object, hr?: object, derived?: object }} Sample
 * @typedef {{
 *   deviceId: string,
 *   athleteId?: string,
 *   samples: Sample[],
 *   updatedAt: number,
 *   firstSeenAt: number,
 * }} SessionRow
 */

function trimSessions() {
  if (sessions.size <= MAX_SESSIONS) return;
  const sorted = [...sessions.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  const remove = sorted.length - MAX_SESSIONS;
  for (let i = 0; i < remove; i++) sessions.delete(sorted[i][0]);
}

function trimSampleRing(row) {
  if (row.samples.length > MAX_SAMPLES_PER_SESSION) {
    row.samples = row.samples.slice(-MAX_SAMPLES_PER_SESSION);
  } else if (row.samples.length > RING_TRIM_TO) {
    row.samples = row.samples.slice(-RING_TRIM_TO);
  }
}

/**
 * @param {Sample[]} samples
 * @param {number} windowMs
 * @param {string} [deviceId]
 */
function sensorStats(samples, windowMs, deviceId) {
  const now = Date.now();
  const cutoff = now - windowMs;
  const recent = samples.filter((s) => s.t >= cutoff);
  const clearAt = getCapsizeClearAt(deviceId);
  const afterClear = (t) => !clearAt || t > clearAt;

  let gpsCount = 0;
  let motionCount = 0;
  let hrCount = 0;
  let lastGps = null;
  let lastMotion = null;
  let lastHr = null;
  let lastDerived = null;
  let capsizeInWindow = false;

  for (const s of recent) {
    if (s.gps && s.gps.lat != null && s.gps.lon != null) {
      gpsCount++;
      lastGps = { t: s.t, lat: s.gps.lat, lon: s.gps.lon, acc: s.gps.acc };
    }
    if (s.motion && s.motion.ax != null) {
      motionCount++;
      lastMotion = { t: s.t, ...s.motion };
    }
    if (s.hr && s.hr.bpm != null) {
      hrCount++;
      lastHr = { t: s.t, bpm: s.hr.bpm };
    }
    if (s.derived) {
      lastDerived = { t: s.t, ...s.derived };
      if (s.derived.capsize === true && afterClear(s.t)) capsizeInWindow = true;
    }
  }

  const motionSamples = recent.filter(
    (s) => s.motion && s.motion.ax != null && afterClear(s.t),
  );
  const analyzed = motionSamples.length ? analyzeMotionWindow(motionSamples) : null;
  const strokeRate =
    analyzed?.strokeRate ??
    (lastDerived?.strokeRate != null ? lastDerived.strokeRate : null);
  const derivedCapsize =
    lastDerived?.capsize === true && afterClear(lastDerived.t);
  const capsize =
    capsizeInWindow || Boolean(analyzed?.capsize) || Boolean(derivedCapsize);
  const tiltDeg = analyzed?.tiltDeg ?? lastDerived?.tiltDeg ?? null;

  const windowSec = windowMs / 1000;
  const rate = (n) => (windowSec > 0 ? Math.round((n / windowSec) * 10) / 10 : 0);

  return {
    gps: {
      present: gpsCount > 0,
      rateHz: rate(gpsCount),
      count: gpsCount,
      last: lastGps,
      ageSec: lastGps ? Math.round((now - lastGps.t) / 1000) : null,
    },
    motion: {
      present: motionCount > 0,
      rateHz: rate(motionCount),
      count: motionCount,
      last: lastMotion,
      ageSec: lastMotion ? Math.round((now - lastMotion.t) / 1000) : null,
    },
    hr: {
      present: hrCount > 0,
      rateHz: rate(hrCount),
      count: hrCount,
      last: lastHr,
      ageSec: lastHr ? Math.round((now - lastHr.t) / 1000) : null,
    },
    rowing: {
      strokeRate,
      strokeRateValid: strokeRate != null,
      capsize,
      tiltDeg,
      calibrated: analyzed?.calibrated ?? false,
      ageSec: lastMotion ? Math.round((now - lastMotion.t) / 1000) : null,
    },
    totalInWindow: recent.length,
    ingestRateHz: rate(recent.length),
  };
}

/**
 * @param {string} sessionId
 * @param {string} deviceId
 * @param {string} [athleteId]
 * @param {Sample[]} samples
 */
async function recordBatch(sessionId, deviceId, athleteId, samples) {
  if (!samples.length) return { received: 0 };

  const key = String(sessionId);
  const now = Date.now();
  let row = sessions.get(key);
  if (!row) {
    row = {
      deviceId: String(deviceId),
      athleteId: athleteId ? String(athleteId) : undefined,
      samples: [],
      updatedAt: now,
      firstSeenAt: now,
    };
    sessions.set(key, row);
  }

  row.deviceId = String(deviceId);
  if (athleteId) row.athleteId = String(athleteId);
  row.samples.push(...samples);
  row.updatedAt = now;
  trimSampleRing(row);
  trimSessions();

  let persisted = false;
  let persistError = null;
  try {
    if (db.hasDb()) {
      persisted = await db.persistBatch(sessionId, deviceId, athleteId, samples);
    }
  } catch (err) {
    persistError = err instanceof Error ? err.message : String(err);
    console.error('[ingest-store] DB persist failed:', err);
  }

  return {
    received: samples.length,
    total: row.samples.length,
    persisted,
    persistError,
  };
}

/**
 * @param {string} sessionId
 */
async function getSession(sessionId) {
  if (db.hasDb()) {
    try {
      const fromDb = await db.getSessionFromDb(sessionId);
      if (fromDb) return fromDb;
    } catch (err) {
      console.error('[ingest-store] DB getSession failed:', err);
    }
  }
  const row = sessions.get(String(sessionId));
  if (!row) return undefined;
  return { sessionId, ...row };
}

function buildDeviceEntry(entry, windowMs, onlineMs, now) {
  const stats = sensorStats(entry.samples, windowMs, entry.deviceId);
  const lastSeenMs = entry.lastSeenMs ?? entry.updatedAt ?? now;
  const online = now - lastSeenMs <= onlineMs;
  return {
    deviceId: entry.deviceId,
    athleteId: entry.athleteId || null,
    sessionId: entry.sessionId,
    online,
    lastSeenMs,
    lastSeenAgoSec: Math.round((now - lastSeenMs) / 1000),
    firstSeenMs: entry.firstSeenMs ?? entry.firstSeenAt ?? lastSeenMs,
    totalSamples: entry.samples.length,
    ...stats,
  };
}

/**
 * @param {{ windowMs?: number, onlineMs?: number }} [opts]
 */
function listDevicesFromMemory(opts = {}) {
  const windowMs = opts.windowMs ?? 60000;
  const onlineMs = opts.onlineMs ?? 30000;
  const now = Date.now();
  const byDevice = new Map();

  for (const [sessionId, row] of sessions) {
    const built = buildDeviceEntry(
      {
        deviceId: row.deviceId,
        athleteId: row.athleteId,
        sessionId,
        samples: row.samples,
        lastSeenMs: row.updatedAt,
        firstSeenMs: row.firstSeenAt,
      },
      windowMs,
      onlineMs,
      now,
    );
    const prev = byDevice.get(row.deviceId);
    if (!prev || built.lastSeenMs > prev.lastSeenMs) {
      byDevice.set(row.deviceId, built);
    }
  }

  return byDevice;
}

/**
 * @param {{ windowMs?: number, onlineMs?: number }} [opts]
 */
async function listDevices(opts = {}) {
  const windowMs = opts.windowMs ?? 60000;
  const onlineMs = opts.onlineMs ?? 30000;
  const now = Date.now();
  const hasPostgres = db.hasDb();

  /** @type {Map<string, object>} */
  const byDevice = listDevicesFromMemory(opts);

  let storage = hasPostgres ? 'postgres' : 'memory';
  let warning = hasPostgres
    ? null
    : 'No database configured — monitor only sees data on the same server instance. Add POSTGRES_URL in Vercel and redeploy.';

  if (hasPostgres) {
    try {
      const fromDb = await db.fetchRecentSamplesByDevice(windowMs);
      for (const entry of fromDb.values()) {
        const built = buildDeviceEntry(entry, windowMs, onlineMs, now);
        const prev = byDevice.get(entry.deviceId);
        if (!prev || built.lastSeenMs > prev.lastSeenMs) {
          byDevice.set(entry.deviceId, built);
        }
      }
      warning = null;
    } catch (err) {
      console.error('[ingest-store] listDevices DB failed:', err);
      storage = 'memory';
      warning = `Database read failed: ${err.message}`;
    }
  }

  const devices = [...byDevice.values()].sort(
    (a, b) => b.lastSeenMs - a.lastSeenMs,
  );

  return {
    polledAt: now,
    windowSec: windowMs / 1000,
    onlineThresholdSec: onlineMs / 1000,
    activeCount: devices.filter((d) => d.online).length,
    deviceCount: devices.length,
    devices,
    persisted: hasPostgres,
    storage,
    warning,
  };
}

function getPositionsSnapshot(onlineMs = 30000) {
  const now = Date.now();
  /** @type {Map<string, object>} */
  const byDevice = new Map();

  for (const [sessionId, row] of sessions) {
    let lastGps = null;
    let lastHr = null;
    let lastMotion = null;
    for (let i = row.samples.length - 1; i >= 0; i--) {
      const s = row.samples[i];
      if (!lastGps && s.gps?.lat != null && s.gps?.lon != null) lastGps = s;
      if (!lastHr && s.hr?.bpm != null) lastHr = s;
      if (!lastMotion && s.motion?.ax != null) lastMotion = s;
      if (lastGps && lastHr && lastMotion) break;
    }
    if (!lastGps) continue;

    const fixMs = lastGps.t;
    const pos = {
      uniqueId: row.deviceId,
      deviceId: row.deviceId,
      sessionId,
      athleteId: row.athleteId || null,
      latitude: lastGps.gps.lat,
      longitude: lastGps.gps.lon,
      accuracy: lastGps.gps.acc ?? null,
      speed: lastGps.gps.spd ?? null,
      course: lastGps.gps.hdg ?? null,
      altitude: lastGps.gps.alt ?? null,
      fixTime: new Date(fixMs).toISOString(),
      deviceTime: new Date(fixMs).toISOString(),
      lastUpdate: row.updatedAt,
      online: now - row.updatedAt <= onlineMs,
      attributes: {
        ...(lastHr ? { hr: lastHr.hr.bpm, heartRate: lastHr.hr.bpm } : {}),
        ...(lastMotion
          ? {
              ax: lastMotion.motion.ax,
              ay: lastMotion.motion.ay,
              az: lastMotion.motion.az,
            }
          : {}),
      },
    };

    const prev = byDevice.get(row.deviceId);
    if (!prev || row.updatedAt > prev.lastUpdate) {
      byDevice.set(row.deviceId, pos);
    }
  }

  return {
    polledAt: now,
    onlineThresholdSec: onlineMs / 1000,
    positions: [...byDevice.values()].sort((a, b) => b.lastUpdate - a.lastUpdate),
  };
}

function attachRowingToMapPositions(positions, rowingByDevice) {
  for (const p of positions) {
    const rowing = rowingByDevice.get(p.deviceId);
    if (!rowing) continue;
    p.strokeRate = rowing.strokeRate;
    p.strokeRateValid = rowing.strokeRateValid;
    p.capsize = rowing.capsize;
    p.tiltDeg = rowing.tiltDeg;
  }
  return positions;
}

/**
 * @param {Map<string, { samples: Sample[] }>} byDevice
 * @param {number} windowMs
 */
function rowingMetricsByDevice(byDevice, windowMs) {
  /** @type {Map<string, object>} */
  const out = new Map();
  for (const [deviceId, entry] of byDevice) {
    const stats = sensorStats(entry.samples || [], windowMs, deviceId);
    out.set(deviceId, stats.rowing);
  }
  return out;
}

/**
 * Dismiss capsize alert on the monitor (per device or all currently alerting).
 * @param {string} [deviceId]
 */
async function clearCapsizeAlert(deviceId) {
  const now = Date.now();
  if (deviceId) {
    setCapsizeClear(deviceId);
    return { cleared: [String(deviceId)], clearedAt: now };
  }
  const snapshot = await listDevices({
    windowMs: 120000,
    onlineMs: 24 * 60 * 60 * 1000,
  });
  const capsized = (snapshot.devices || [])
    .filter((d) => d.rowing?.capsize)
    .map((d) => d.deviceId);
  for (const id of capsized) setCapsizeClear(id);
  return { cleared: capsized, clearedAt: now };
}

/** Recent motion samples per device (in-memory ingest). */
function samplesByDeviceForWindow(windowMs) {
  const now = Date.now();
  const cutoff = now - windowMs;
  /** @type {Map<string, { samples: Sample[] }>} */
  const byDevice = new Map();
  for (const row of sessions.values()) {
    const samples = row.samples.filter((s) => s.t >= cutoff);
    if (!samples.length) continue;
    const prev = byDevice.get(row.deviceId);
    if (!prev || row.updatedAt > prev.lastSeenMs) {
      byDevice.set(row.deviceId, { samples, lastSeenMs: row.updatedAt });
    }
  }
  return byDevice;
}

async function getMapPositions(onlineMs, staleMs) {
  const rowingWindowMs = Math.min(staleMs, 120000);
  const now = Date.now();

  if (db.hasDb()) {
    try {
      const positions = await db.getMapPositions(onlineMs, staleMs);
      const byDevice = await db.fetchRecentSamplesByDevice(rowingWindowMs);
      attachRowingToMapPositions(
        positions,
        rowingMetricsByDevice(byDevice, rowingWindowMs),
      );
      return positions;
    } catch (err) {
      console.error('[ingest-store] getMapPositions DB failed:', err);
    }
  }

  const mem = getPositionsSnapshot(onlineMs);
  const rowingByDevice = rowingMetricsByDevice(
    samplesByDeviceForWindow(rowingWindowMs),
    rowingWindowMs,
  );

  return mem.positions
    .filter((p) => {
      const fixMs = new Date(p.fixTime).getTime();
      return (
        Number.isFinite(fixMs) &&
        now - fixMs <= staleMs &&
        p.latitude != null &&
        p.longitude != null
      );
    })
    .map((p) => {
      const fixMs = new Date(p.fixTime).getTime();
      const lastSeenMs = p.lastUpdate || fixMs;
      const rowing = rowingByDevice.get(String(p.uniqueId)) || {};
      return {
        deviceId: String(p.uniqueId),
        athleteId: p.athleteId || null,
        latitude: p.latitude,
        longitude: p.longitude,
        accuracy: p.accuracy,
        fixMs,
        fixAgeSec: Math.round((now - fixMs) / 1000),
        lastSeenAgoSec: Math.round((now - lastSeenMs) / 1000),
        online: Boolean(p.online),
        hr: p.attributes?.hr ?? p.attributes?.heartRate ?? null,
        strokeRate: rowing.strokeRate ?? null,
        strokeRateValid: Boolean(rowing.strokeRateValid),
        capsize: Boolean(rowing.capsize),
        tiltDeg: rowing.tiltDeg ?? null,
      };
    });
}

async function getTraccarSnapshot(onlineMs = 120000) {
  if (db.hasDb()) {
    try {
      return await db.getTraccarSnapshot(onlineMs);
    } catch (err) {
      console.error('[ingest-store] DB snapshot failed:', err);
    }
  }
  const mem = getPositionsSnapshot(onlineMs);
  const devices = mem.positions.map((p, i) => ({
    id: i + 1,
    name: p.uniqueId,
    uniqueId: p.uniqueId,
    status: p.online ? 'online' : 'offline',
  }));
  const positions = mem.positions.map((p, i) => ({
    id: i + 1,
    deviceId: i + 1,
    latitude: p.latitude,
    longitude: p.longitude,
    altitude: p.altitude || 0,
    speed: p.speed || 0,
    course: p.course || 0,
    accuracy: p.accuracy || 0,
    fixTime: p.fixTime,
    deviceTime: p.deviceTime,
    serverTime: p.fixTime,
    attributes: p.attributes || {},
    deviceName: p.uniqueId,
  }));
  return { devices, positions, geofences: [], groups: [] };
}

async function getRouteHistory(deviceIdParam, uniqueIdParam, fromIso, toIso) {
  if (db.hasDb()) {
    const dev = await db.resolveDevice(deviceIdParam, uniqueIdParam);
    if (!dev) return [];
    return db.getRoutePositions(dev.id, fromIso, toIso);
  }
  return [];
}

async function listSessionsHistory(uniqueId) {
  if (!db.hasDb()) return [];
  try {
    return await db.listSessions(uniqueId, 80);
  } catch (err) {
    console.error('[ingest-store] listSessions failed:', err);
    return [];
  }
}

function checkAuth(req) {
  const expected = process.env.INGEST_TOKEN || '';
  if (!expected) return true;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const q = req.query?.token;
  return token === expected || q === expected;
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = {
  MAX_SAMPLES_PER_REQUEST,
  recordBatch,
  getSession,
  listDevices,
  getPositionsSnapshot,
  getTraccarSnapshot,
  getMapPositions,
  getRouteHistory,
  listSessionsHistory,
  clearCapsizeAlert,
  checkAuth,
  cors,
  hasDb: db.hasDb,
};
