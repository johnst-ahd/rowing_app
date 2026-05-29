const db = require('./db');
const { analyzeMotionWindow } = require('./motion-analysis');

const MAX_SAMPLES_PER_REQUEST = 500;
const MAX_SESSIONS = 200;
const MAX_SAMPLES_PER_SESSION = 50000;
const RING_TRIM_TO = 3000;
const MAX_GPS_ACCURACY_M = 150;
const MAX_TRACK_SPEED_MPS = 22;
const MAX_TRACK_ACCEL_MPS2 = 6;
const MAX_PREDICT_MS = 8000;

/** @type {Map<string, SessionRow>} */
const sessions = globalThis.__rnzIngestSessions ?? new Map();
globalThis.__rnzIngestSessions = sessions;

/** Monitor dismissed capsize per device (timestamp); ignores older capsize samples. */
/** @type {Map<string, number>} */
const capsizeClearAt = globalThis.__rnzCapsizeClearAt ?? new Map();
globalThis.__rnzCapsizeClearAt = capsizeClearAt;
/** @type {Map<string, GpsTrack>} */
const gpsTracks = globalThis.__rnzGpsTracks ?? new Map();
globalThis.__rnzGpsTracks = gpsTracks;
/** @type {Map<string, { t:number, result: object }>} */
const recentIdempotency = globalThis.__rnzRecentIdempotency ?? new Map();
/** @type {Map<string, { t: number }>} */
const lastHeartbeatByDevice = globalThis.__rnzLastHeartbeat ?? new Map();
globalThis.__rnzLastHeartbeat = lastHeartbeatByDevice;
/** @type {Map<string, { t: number, pct: number }>} */
const lastBatteryByDevice = globalThis.__rnzLastBattery ?? new Map();
globalThis.__rnzLastBattery = lastBatteryByDevice;
globalThis.__rnzRecentIdempotency = recentIdempotency;
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const metrics = globalThis.__rnzIngestMetrics ?? {
  startedAt: Date.now(),
  requests: 0,
  duplicates: 0,
  droppedSamples: 0,
  persistedBatches: 0,
  persistFailures: 0,
  lastPersistError: null,
  lastPersistAt: null,
  mapPolls: 0,
};
globalThis.__rnzIngestMetrics = metrics;

/**
 * @typedef {{
 *   t: number,
 *   rawT: number,
 *   lat: number,
 *   lon: number,
 *   vLat: number,
 *   vLon: number,
 *   speedMps: number,
 *   courseDeg: number | null,
 *   accuracy: number | null,
 * }} GpsTrack
 */

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

function pruneIdempotency(now = Date.now()) {
  for (const [key, entry] of recentIdempotency.entries()) {
    if (now - entry.t > IDEMPOTENCY_TTL_MS) recentIdempotency.delete(key);
  }
}

function isValidGpsCoords(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (Math.abs(lat) < 1e-4 && Math.abs(lon) < 1e-4) return false;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
  return true;
}

function gpsFromSample(sample, { forTrack = false } = {}) {
  if (!sample || typeof sample !== 'object' || !sample.gps) return null;
  const lat = Number(sample.gps.lat);
  const lon = Number(sample.gps.lon);
  if (!isValidGpsCoords(lat, lon)) return null;
  const acc =
    sample.gps.acc != null && Number.isFinite(Number(sample.gps.acc))
      ? Number(sample.gps.acc)
      : null;
  if (forTrack && acc != null && acc > MAX_GPS_ACCURACY_M) return null;
  const t = Number(sample.t);
  if (!Number.isFinite(t)) return null;
  const spd =
    sample.gps.spd != null && Number.isFinite(Number(sample.gps.spd))
      ? Math.max(0, Number(sample.gps.spd))
      : null;
  const hdg =
    sample.gps.hdg != null && Number.isFinite(Number(sample.gps.hdg))
      ? Number(sample.gps.hdg)
      : null;
  return { t, lat, lon, acc, spd, hdg };
}

function metersPerDegLat() {
  return 111320;
}

function metersPerDegLon(lat) {
  return Math.max(1, 111320 * Math.cos((lat * Math.PI) / 180));
}

function distanceMeters(aLat, aLon, bLat, bLon) {
  const dLatM = (aLat - bLat) * metersPerDegLat();
  const dLonM = (aLon - bLon) * metersPerDegLon((aLat + bLat) / 2);
  return Math.hypot(dLatM, dLonM);
}

function velocityFromSpeedHeading(spd, hdg, lat) {
  if (spd == null || hdg == null) return null;
  const r = (hdg * Math.PI) / 180;
  const vNorth = Math.cos(r) * spd;
  const vEast = Math.sin(r) * spd;
  return {
    vLat: vNorth / metersPerDegLat(),
    vLon: vEast / metersPerDegLon(lat),
    speedMps: spd,
  };
}

function blend(a, b, w) {
  return a * (1 - w) + b * w;
}

/**
 * @param {string} deviceId
 * @param {{ t:number, lat:number, lon:number, acc:number|null, spd:number|null, hdg:number|null }} fix
 */
function updateGpsTrack(deviceId, fix) {
  const key = String(deviceId);
  const prev = gpsTracks.get(key);
  if (!prev) {
    const vh = velocityFromSpeedHeading(fix.spd, fix.hdg, fix.lat);
    gpsTracks.set(key, {
      t: fix.t,
      rawT: fix.t,
      lat: fix.lat,
      lon: fix.lon,
      vLat: vh?.vLat ?? 0,
      vLon: vh?.vLon ?? 0,
      speedMps: vh?.speedMps ?? 0,
      courseDeg: fix.hdg ?? null,
      accuracy: fix.acc,
    });
    return true;
  }

  const dt = (fix.t - prev.t) / 1000;
  if (!Number.isFinite(dt) || dt <= 0) {
    return false;
  }
  if (dt > 30) {
    const vh = velocityFromSpeedHeading(fix.spd, fix.hdg, fix.lat);
    gpsTracks.set(key, {
      t: fix.t,
      rawT: fix.t,
      lat: fix.lat,
      lon: fix.lon,
      vLat: vh?.vLat ?? 0,
      vLon: vh?.vLon ?? 0,
      speedMps: vh?.speedMps ?? 0,
      courseDeg: fix.hdg ?? null,
      accuracy: fix.acc,
    });
    return true;
  }

  const predLat = prev.lat + prev.vLat * dt;
  const predLon = prev.lon + prev.vLon * dt;
  const innovationM = distanceMeters(fix.lat, fix.lon, predLat, predLon);
  const obsSpeed = innovationM / dt;
  const accel = Math.abs(obsSpeed - prev.speedMps) / Math.max(0.25, dt);
  if (obsSpeed > MAX_TRACK_SPEED_MPS || accel > MAX_TRACK_ACCEL_MPS2) {
    return false;
  }

  const acc = fix.acc ?? 12;
  const alpha = acc <= 8 ? 0.7 : acc <= 20 ? 0.45 : 0.25;
  const beta = acc <= 8 ? 0.16 : acc <= 20 ? 0.1 : 0.05;
  const residLat = fix.lat - predLat;
  const residLon = fix.lon - predLon;
  const nextLat = predLat + alpha * residLat;
  const nextLon = predLon + alpha * residLon;
  let nextVLat = prev.vLat + (beta * residLat) / dt;
  let nextVLon = prev.vLon + (beta * residLon) / dt;

  const vh = velocityFromSpeedHeading(fix.spd, fix.hdg, nextLat);
  if (vh) {
    nextVLat = blend(nextVLat, vh.vLat, 0.35);
    nextVLon = blend(nextVLon, vh.vLon, 0.35);
  }
  const speedMps = Math.hypot(
    nextVLat * metersPerDegLat(),
    nextVLon * metersPerDegLon(nextLat),
  );

  gpsTracks.set(key, {
    t: fix.t,
    rawT: fix.t,
    lat: nextLat,
    lon: nextLon,
    vLat: nextVLat,
    vLon: nextVLon,
    speedMps: Number.isFinite(speedMps) ? speedMps : 0,
    courseDeg: fix.hdg ?? prev.courseDeg ?? null,
    accuracy: fix.acc ?? prev.accuracy ?? null,
  });
  return true;
}

function projectTrack(track, nowMs) {
  const dt = Math.max(0, Math.min(MAX_PREDICT_MS, nowMs - track.t)) / 1000;
  const lat = track.lat + track.vLat * dt;
  const lon = track.lon + track.vLon * dt;
  const speed = track.speedMps ?? 0;
  const course =
    track.courseDeg != null
      ? track.courseDeg
      : speed > 0.1
        ? ((Math.atan2(
            track.vLon * metersPerDegLon(lat),
            track.vLat * metersPerDegLat(),
          ) *
            180) /
            Math.PI +
            360) %
          360
        : null;
  return {
    latitude: lat,
    longitude: lon,
    speed: speed > 0.01 ? speed : null,
    course,
    projected: dt > 0,
    predictedAgeMs: Math.round(dt * 1000),
  };
}

/**
 * @param {Sample[]} samples
 * @returns {{ t: number, pct: number } | null}
 */
function latestBatteryFromSamples(samples) {
  for (let i = samples.length - 1; i >= 0; i--) {
    const d = samples[i]?.derived;
    if (d && d.batteryPct != null && Number.isFinite(Number(d.batteryPct))) {
      return {
        t: samples[i].t,
        pct: Math.max(0, Math.min(100, Math.round(Number(d.batteryPct)))),
      };
    }
  }
  return null;
}

/**
 * @param {string} deviceId
 * @param {Sample[]} samples
 */
function noteDeviceTelemetry(deviceId, samples) {
  const id = String(deviceId);
  for (const s of samples) {
    if (s?.derived?.heartbeat === true) {
      lastHeartbeatByDevice.set(id, { t: s.t });
    }
    const pct = s?.derived?.batteryPct;
    if (pct != null && Number.isFinite(Number(pct))) {
      lastBatteryByDevice.set(id, {
        t: s.t,
        pct: Math.max(0, Math.min(100, Math.round(Number(pct)))),
      });
    }
  }
}

function sanitizeAndTrackSamples(deviceId, samples) {
  const out = [];
  let dropped = 0;
  for (const sample of samples) {
    if (!sample || typeof sample !== 'object') {
      dropped++;
      continue;
    }
    let next = sample;
    if (sample.gps) {
      const fix = gpsFromSample(sample);
      if (!fix) {
        const { gps, ...rest } = sample;
        const hasPayload =
          rest.motion != null || rest.hr != null || rest.derived != null;
        if (!hasPayload) {
          dropped++;
          continue;
        }
        next = rest;
      } else {
        const trackFix = gpsFromSample(sample, { forTrack: true });
        if (trackFix) updateGpsTrack(deviceId, trackFix);
      }
    }
    out.push(next);
  }
  return { samples: out, dropped };
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
  let heartbeatCount = 0;
  let lastHeartbeatT = null;

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
      if (s.derived.heartbeat === true) {
        heartbeatCount++;
        lastHeartbeatT = s.t;
      }
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
    heartbeat: {
      present: heartbeatCount > 0,
      rateHz: rate(heartbeatCount),
      count: heartbeatCount,
      lastT: lastHeartbeatT,
      ageSec: lastHeartbeatT ? Math.round((now - lastHeartbeatT) / 1000) : null,
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
 * @param {string} [idempotencyKey]
 */
async function recordBatch(sessionId, deviceId, athleteId, samples, idempotencyKey) {
  metrics.requests++;
  const dedupeKey = idempotencyKey ? String(idempotencyKey) : '';
  const now = Date.now();
  pruneIdempotency(now);
  if (dedupeKey && db.hasDb()) {
    try {
      const dbCached = await db.getIdempotency(dedupeKey, IDEMPOTENCY_TTL_MS);
      if (dbCached) {
        metrics.duplicates++;
        recentIdempotency.set(dedupeKey, { t: now, result: dbCached });
        return { ...dbCached, duplicate: true };
      }
    } catch (err) {
      console.error('[ingest-store] DB idempotency read failed:', err);
    }
  }
  if (dedupeKey) {
    const cached = recentIdempotency.get(dedupeKey);
    if (cached && now - cached.t <= IDEMPOTENCY_TTL_MS) {
      metrics.duplicates++;
      return { ...cached.result, duplicate: true };
    }
  }
  if (!samples.length) return { received: 0 };
  const clean = sanitizeAndTrackSamples(deviceId, samples);
  if (!clean.samples.length) {
    metrics.droppedSamples += clean.dropped || 0;
    return { received: 0, dropped: clean.dropped };
  }
  metrics.droppedSamples += clean.dropped || 0;

  const key = String(sessionId);
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
  row.samples.push(...clean.samples);
  row.updatedAt = now;
  noteDeviceTelemetry(deviceId, clean.samples);
  trimSampleRing(row);
  trimSessions();

  let persisted = false;
  let persistError = null;
  try {
    if (db.hasDb()) {
      persisted = await db.persistBatch(
        sessionId,
        deviceId,
        athleteId,
        clean.samples,
      );
      if (persisted) {
        metrics.persistedBatches++;
        metrics.lastPersistAt = now;
      }
    }
  } catch (err) {
    persistError = err instanceof Error ? err.message : String(err);
    console.error('[ingest-store] DB persist failed:', err);
    metrics.persistFailures++;
    metrics.lastPersistError = String(persistError).slice(0, 300);
  }

  const result = {
    received: clean.samples.length,
    dropped: clean.dropped || undefined,
    total: row.samples.length,
    persisted,
    persistError,
  };
  if (dedupeKey) {
    recentIdempotency.set(dedupeKey, { t: now, result });
    if (db.hasDb()) {
      try {
        await db.setIdempotency(dedupeKey, result);
      } catch (err) {
        console.error('[ingest-store] DB idempotency write failed:', err);
      }
    }
  }
  return result;
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
  const hbMem = lastHeartbeatByDevice.get(entry.deviceId);
  const batFromSamples = latestBatteryFromSamples(entry.samples || []);
  const batMem = lastBatteryByDevice.get(entry.deviceId);
  const bat =
    batFromSamples && batMem
      ? batFromSamples.t >= batMem.t
        ? batFromSamples
        : batMem
      : batFromSamples || batMem || null;
  const lastHbT = Math.max(hbMem?.t ?? 0, stats.heartbeat?.lastT ?? 0);
  const heartbeat = {
    present: (stats.heartbeat?.count ?? 0) > 0 || lastHbT > 0,
    rateHz: stats.heartbeat?.rateHz ?? 0,
    count: stats.heartbeat?.count ?? 0,
    ageSec: lastHbT ? Math.round((now - lastHbT) / 1000) : null,
  };
  const battery = bat
    ? {
        pct: bat.pct,
        ageSec: Math.round((now - bat.t) / 1000),
      }
    : { pct: null, ageSec: null };
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
    heartbeat,
    battery,
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
      const fetchMs = Math.max(windowMs, 30 * 60 * 1000);
      const fromDb = await db.fetchRecentSamplesByDevice(fetchMs);
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
  const onlineDevices = devices.filter((d) => d.online);
  const gpsAges = onlineDevices
    .map((d) => d.gps?.ageSec)
    .filter((v) => Number.isFinite(v));
  const ingestRates = onlineDevices
    .map((d) => d.ingestRateHz)
    .filter((v) => Number.isFinite(v));
  const gpsRates = onlineDevices
    .map((d) => d.gps?.rateHz)
    .filter((v) => Number.isFinite(v) && v > 0);
  const strokeRates = onlineDevices
    .map((d) => d.rowing?.strokeRate)
    .filter((v) => Number.isFinite(v) && v > 0);
  const heartbeatRates = onlineDevices
    .map((d) => d.heartbeat?.rateHz)
    .filter((v) => Number.isFinite(v) && v > 0);
  const heartbeatAges = onlineDevices
    .map((d) => d.heartbeat?.ageSec)
    .filter((v) => Number.isFinite(v));
  const batteryPcts = onlineDevices
    .map((d) => d.battery?.pct)
    .filter((v) => Number.isFinite(v));
  const maxLastSeenMs = devices.length
    ? Math.max(...devices.map((d) => d.lastSeenMs || 0))
    : null;
  const health = {
    status:
      warning != null
        ? 'degraded'
        : onlineDevices.length === 0
          ? 'idle'
          : 'ok',
    onlineDevices: onlineDevices.length,
    delayedGpsDevices: onlineDevices.filter((d) => (d.gps?.ageSec ?? 1e9) > 30).length,
    capsizeDevices: onlineDevices.filter((d) => d.rowing?.capsize).length,
    avgGpsAgeSec: gpsAges.length
      ? Math.round((gpsAges.reduce((a, b) => a + b, 0) / gpsAges.length) * 10) / 10
      : null,
    avgIngestHz: ingestRates.length
      ? Math.round((ingestRates.reduce((a, b) => a + b, 0) / ingestRates.length) * 10) / 10
      : null,
    avgGpsHz: gpsRates.length
      ? Math.round((gpsRates.reduce((a, b) => a + b, 0) / gpsRates.length) * 10) / 10
      : null,
    avgStrokeSpm: strokeRates.length
      ? Math.round(strokeRates.reduce((a, b) => a + b, 0) / strokeRates.length)
      : null,
    avgHeartbeatHz: heartbeatRates.length
      ? Math.round((heartbeatRates.reduce((a, b) => a + b, 0) / heartbeatRates.length) * 10) /
        10
      : null,
    avgHeartbeatAgeSec: heartbeatAges.length
      ? Math.round((heartbeatAges.reduce((a, b) => a + b, 0) / heartbeatAges.length) * 10) / 10
      : null,
    avgBatteryPct: batteryPcts.length
      ? Math.round(batteryPcts.reduce((a, b) => a + b, 0) / batteryPcts.length)
      : null,
    minBatteryPct: batteryPcts.length ? Math.min(...batteryPcts) : null,
    serverDataLagSec:
      maxLastSeenMs != null ? Math.max(0, Math.round((now - maxLastSeenMs) / 1000)) : null,
  };

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
    health,
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
    const track = gpsTracks.get(String(row.deviceId));
    const projected =
      track && Number.isFinite(track.t) ? projectTrack(track, now) : null;
    const pos = {
      uniqueId: row.deviceId,
      deviceId: row.deviceId,
      sessionId,
      athleteId: row.athleteId || null,
      latitude: projected?.latitude ?? lastGps.gps.lat,
      longitude: projected?.longitude ?? lastGps.gps.lon,
      accuracy: track?.accuracy ?? lastGps.gps.acc ?? null,
      speed: projected?.speed ?? lastGps.gps.spd ?? null,
      course: projected?.course ?? lastGps.gps.hdg ?? null,
      altitude: lastGps.gps.alt ?? null,
      fixTime: new Date(fixMs).toISOString(),
      deviceTime: new Date(fixMs).toISOString(),
      lastUpdate: row.updatedAt,
      online: now - row.updatedAt <= onlineMs,
      attributes: {
        ...(projected
          ? {
              smoothed: true,
              projected: projected.projected,
              predictedAgeMs: projected.predictedAgeMs,
            }
          : {}),
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
 * @param {object[]} positions
 * @param {Map<string, { samples: Sample[] }>} byDevice
 * @param {number} windowMs
 */
function attachTelemetryToMapPositions(positions, byDevice, windowMs) {
  const now = Date.now();
  for (const p of positions) {
    const entry = byDevice.get(p.deviceId);
    if (!entry) continue;
    const stats = sensorStats(entry.samples || [], windowMs, p.deviceId);
    const hbMem = lastHeartbeatByDevice.get(p.deviceId);
    const batFromSamples = latestBatteryFromSamples(entry.samples || []);
    const batMem = lastBatteryByDevice.get(p.deviceId);
    const bat =
      batFromSamples && batMem
        ? batFromSamples.t >= batMem.t
          ? batFromSamples
          : batMem
        : batFromSamples || batMem || null;
    const lastHbT = Math.max(hbMem?.t ?? 0, stats.heartbeat?.lastT ?? 0);
    p.heartbeatRateHz = stats.heartbeat?.rateHz ?? 0;
    p.heartbeatAgeSec = lastHbT ? Math.round((now - lastHbT) / 1000) : null;
    if (bat) {
      p.batteryPct = bat.pct;
      p.batteryAgeSec = Math.round((now - bat.t) / 1000);
    }
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
  metrics.mapPolls++;
  const rowingWindowMs = Math.min(staleMs, 120000);
  const telemetryWindowMs = Math.max(rowingWindowMs, 30 * 60 * 1000);
  const now = Date.now();

  if (db.hasDb()) {
    try {
      const positions = await db.getMapPositions(onlineMs, staleMs);
      const byDevice = await db.fetchRecentSamplesByDevice(telemetryWindowMs);
      attachRowingToMapPositions(
        positions,
        rowingMetricsByDevice(byDevice, rowingWindowMs),
      );
      attachTelemetryToMapPositions(positions, byDevice, rowingWindowMs);
      return positions;
    } catch (err) {
      console.error('[ingest-store] getMapPositions DB failed:', err);
    }
  }

  const mem = getPositionsSnapshot(onlineMs);
  const telemetryByDevice = samplesByDeviceForWindow(telemetryWindowMs);
  const rowingByDevice = rowingMetricsByDevice(telemetryByDevice, rowingWindowMs);

  const mapped = mem.positions
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
  return attachTelemetryToMapPositions(mapped, telemetryByDevice, rowingWindowMs);
}

function getMetrics() {
  const uptimeSec = Math.max(1, Math.round((Date.now() - metrics.startedAt) / 1000));
  return {
    startedAt: metrics.startedAt,
    uptimeSec,
    requests: metrics.requests,
    duplicates: metrics.duplicates,
    droppedSamples: metrics.droppedSamples,
    persistedBatches: metrics.persistedBatches,
    persistFailures: metrics.persistFailures,
    lastPersistError: metrics.lastPersistError,
    lastPersistAt: metrics.lastPersistAt,
    mapPolls: metrics.mapPolls,
    requestRateHz: Math.round((metrics.requests / uptimeSec) * 100) / 100,
  };
}

async function getTraccarSnapshot(onlineMs = 120000) {
  if (db.hasDb()) {
    try {
      const snap = await db.getTraccarSnapshot(onlineMs);
      const now = Date.now();
      snap.positions = (snap.positions || []).map((p) => {
        const key = String(p.deviceName || p.attributes?.uniqueId || p.deviceId || '');
        const track = gpsTracks.get(key);
        if (!track) return p;
        const projected = projectTrack(track, now);
        return {
          ...p,
          latitude: projected.latitude,
          longitude: projected.longitude,
          speed: projected.speed ?? p.speed,
          course: projected.course ?? p.course,
          accuracy: track.accuracy ?? p.accuracy,
          attributes: {
            ...(p.attributes || {}),
            smoothed: true,
            projected: projected.projected,
            predictedAgeMs: projected.predictedAgeMs,
          },
        };
      });
      return snap;
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

async function listHistoryDevices() {
  if (!db.hasDb()) return [];
  try {
    return await db.listHistoryDevicesDetailed();
  } catch (err) {
    console.error('[ingest-store] listHistoryDevices failed:', err);
    return [];
  }
}

async function getDashboardHistory(uniqueId, fromIso, toIso) {
  if (!db.hasDb()) return null;
  try {
    return await db.getDashboardHistory(uniqueId, fromIso, toIso);
  } catch (err) {
    console.error('[ingest-store] getDashboardHistory failed:', err);
    return null;
  }
}

async function getDashboardHistoryBySession(sessionId) {
  if (!db.hasDb()) return null;
  try {
    return await db.getDashboardHistoryBySession(sessionId);
  } catch (err) {
    console.error('[ingest-store] getDashboardHistoryBySession failed:', err);
    return null;
  }
}

function purgeMemorySession(sessionId) {
  sessions.delete(String(sessionId));
}

function purgeMemoryDevice(deviceId) {
  const id = String(deviceId);
  for (const [key, row] of sessions.entries()) {
    if (row.deviceId === id) sessions.delete(key);
  }
}

function purgeAllMemory() {
  sessions.clear();
  capsizeClearAt.clear();
}

async function getStorageStats() {
  if (!db.hasDb()) return null;
  try {
    return await db.getStorageStats();
  } catch (err) {
    console.error('[ingest-store] getStorageStats failed:', err);
    return null;
  }
}

async function deleteStoredSession(sessionId) {
  if (!db.hasDb()) return null;
  const result = await db.deleteSession(sessionId);
  purgeMemorySession(sessionId);
  return result;
}

async function deleteStoredDevice(uniqueId) {
  if (!db.hasDb()) return null;
  const result = await db.deleteDeviceData(uniqueId);
  purgeMemoryDevice(uniqueId);
  capsizeClearAt.delete(String(uniqueId));
  return result;
}

async function deleteStoredRange(uniqueId, fromIso, toIso) {
  if (!db.hasDb()) return null;
  const fromMs = new Date(fromIso).getTime();
  const toMs = new Date(toIso).getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new Error('Invalid from/to dates');
  }
  return db.deleteSamplesInRange(uniqueId, fromMs, toMs);
}

async function deleteAllStoredData() {
  if (!db.hasDb()) return null;
  const result = await db.deleteAllStoredData();
  purgeAllMemory();
  return result;
}

function getDataSecurityInfo() {
  const tokenRequired = Boolean(process.env.INGEST_TOKEN);
  return {
    provider: 'Vercel Postgres (Neon)',
    transport: 'HTTPS (TLS) between phones, dashboard, and API',
    atRest:
      'Encrypted at rest by the cloud provider (Neon/Vercel managed Postgres)',
    accessControl: tokenRequired
      ? 'Writes and deletes require INGEST_TOKEN (Bearer) — same token as phones and this dashboard'
      : 'WARNING: INGEST_TOKEN is not set on Vercel — anyone who knows the API URL can upload or delete data',
    dashboardAccess:
      'This page stores your token in browser localStorage on this computer only',
    retention:
      'No automatic expiry — data stays until you delete it here or in the Neon SQL editor',
    irreversible: 'Deletes are permanent and cannot be undone',
    liveCache:
      'The monitor also keeps short-lived in-memory samples for live maps; deletes clear matching live cache',
    recommendations: [
      'Set a long random INGEST_TOKEN in Vercel project settings',
      'Only share the token with trusted coaches and admins',
      'Use device-specific deletes when possible instead of delete all',
      'Review Neon/Vercel project access (who can open the database console)',
    ],
    tokenRequired,
  };
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
  listHistoryDevices,
  getDashboardHistory,
  getDashboardHistoryBySession,
  clearCapsizeAlert,
  getStorageStats,
  deleteStoredSession,
  deleteStoredDevice,
  deleteStoredRange,
  deleteAllStoredData,
  getDataSecurityInfo,
  getMetrics,
  checkAuth,
  cors,
  hasDb: db.hasDb,
};
