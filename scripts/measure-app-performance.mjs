#!/usr/bin/env node
/**
 * Measure recorder stack performance: API latency, ingest batch efficiency, optional device watch.
 *
 * Usage:
 *   node scripts/measure-app-performance.mjs
 *   INGEST_TOKEN=xxx node scripts/measure-app-performance.mjs --watch H6 --sec 90
 */
import { performance } from 'node:perf_hooks';

const BASE = process.env.ROWING_BASE || 'https://rowing-app-recorder-pwa.vercel.app';
const TOKEN = process.env.INGEST_TOKEN || '';

const args = process.argv.slice(2);
const watchTarget = args.includes('--watch') ? args[args.indexOf('--watch') + 1] : null;
const watchSec = args.includes('--sec')
  ? Number(args[args.indexOf('--sec') + 1])
  : 90;

function headers(json = true) {
  const h = { Accept: 'application/json' };
  if (json) h['Content-Type'] = 'application/json';
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

function pct(sorted, p) {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[i];
}

async function timedFetch(label, url, opts = {}, n = 12) {
  const ms = [];
  let lastBody = null;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    try {
      const res = await fetch(url, { ...opts, headers: { ...headers(opts.body != null), ...opts.headers } });
      const text = await res.text();
      lastBody = text;
      if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 120)}`);
      ms.push(performance.now() - t0);
    } catch (e) {
      return { label, error: e.message, ms: [] };
    }
  }
  ms.sort((a, b) => a - b);
  return {
    label,
    n: ms.length,
    minMs: Math.round(ms[0]),
    p50Ms: Math.round(pct(ms, 0.5)),
    p95Ms: Math.round(pct(ms, 0.95)),
    maxMs: Math.round(ms[ms.length - 1]),
    avgMs: Math.round(ms.reduce((a, b) => a + b, 0) / ms.length),
    sampleBytes: lastBody?.length ?? 0,
  };
}

function sampleGps(t, lat, lon) {
  return {
    t,
    gps: { lat, lon, acc: 8.2, spd: 2.4, hdg: 180, alt: 12 },
    motion: { ax: 0.12, ay: -0.04, az: 9.81 },
    derived: { strokeRate: 28, tiltDeg: 4 },
  };
}

function buildBatch(sampleCount, deviceId = 'PERF-TEST') {
  const sessionId = `perf-${Date.now()}`;
  const now = Date.now();
  const samples = [];
  for (let i = 0; i < sampleCount; i++) {
    samples.push(sampleGps(now - (sampleCount - i) * 1000, -37.9196 + i * 0.00001, 175.5424 + i * 0.00001));
  }
  return { sessionId, deviceId, samples };
}

function bodyBytes(obj) {
  return Buffer.byteLength(JSON.stringify(obj), 'utf8');
}

async function benchmarkIngest() {
  const single = buildBatch(1);
  const batch12 = buildBatch(12);
  const singleBody = bodyBytes(single);
  const batchBody = bodyBytes(batch12);

  const singlePost = await timedFetch(
    'POST /api/ingest (1 sample)',
    `${BASE}/api/ingest`,
    { method: 'POST', body: JSON.stringify(single) },
    10,
  );
  const batchPost = await timedFetch(
    'POST /api/ingest (12 samples)',
    `${BASE}/api/ingest`,
    { method: 'POST', body: JSON.stringify(batch12) },
    10,
  );

  const hourlyGps = 3600;
  const hourlyMotion = 1800;
  const hourlyHb = 360;
  const oldPostsPerHour = hourlyGps + hourlyMotion + hourlyHb;
  const newPostsPerHour = Math.ceil(3600 / 3); // ~3s flush
  const oldBytesPerHour = oldPostsPerHour * (singleBody + 650);
  const newBytesPerHour =
    newPostsPerHour * (batchBody + 650) +
    Math.max(0, hourlyHb - Math.floor(3600 / 10)) * (bodyBytes(buildBatch(1)) + 650);

  return {
    payload: { singleSampleBytes: singleBody, batch12Bytes: batchBody },
    ingestLatency: { singlePost, batchPost },
    uploadModel: {
      oldPostsPerHour,
      newPostsPerHour,
      postReductionPct: Math.round((1 - newPostsPerHour / oldPostsPerHour) * 100),
      oldEstBytesPerHour: oldBytesPerHour,
      newEstBytesPerHour: Math.round(newBytesPerHour),
      bytesReductionPct: Math.round((1 - newBytesPerHour / oldBytesPerHour) * 100),
    },
  };
}

async function fetchDevices() {
  const url = `${BASE}/api/devices?windowSec=60&onlineSec=120&includeMetrics=1`;
  const res = await fetch(url, { headers: headers(false) });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function watchDevice(deviceId, seconds) {
  const intervalMs = 3000;
  const samples = [];
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const t0 = performance.now();
    const data = await fetchDevices();
    const d = (data.devices || []).find((x) => x.deviceId === deviceId);
    samples.push({
      at: new Date().toISOString(),
      fetchMs: Math.round(performance.now() - t0),
      online: d?.online ?? false,
      ingestRateHz: d?.ingestRateHz ?? 0,
      gpsRateHz: d?.gps?.rateHz ?? 0,
      gpsAgeSec: d?.gps?.ageSec ?? null,
      totalInWindow: d?.totalInWindow ?? 0,
      lastSeenAgoSec: d?.lastSeenAgoSec ?? null,
      heartbeatHz: d?.heartbeat?.rateHz ?? 0,
    });
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return samples;
}

function summarizeWatch(samples) {
  if (!samples.length) return null;
  const online = samples.filter((s) => s.online);
  const fetchMs = samples.map((s) => s.fetchMs).sort((a, b) => a - b);
  const ingest = online.map((s) => s.ingestRateHz).filter((x) => x > 0);
  const gps = online.map((s) => s.gpsRateHz).filter((x) => x > 0);
  const ages = online.map((s) => s.gpsAgeSec).filter((x) => x != null);
  return {
    polls: samples.length,
    onlinePolls: online.length,
    fetchLatencyMs: {
      p50: pct(fetchMs, 0.5),
      p95: pct(fetchMs, 0.95),
      max: fetchMs[fetchMs.length - 1],
    },
    avgIngestHz: ingest.length ? Math.round((ingest.reduce((a, b) => a + b, 0) / ingest.length) * 100) / 100 : 0,
    avgGpsHz: gps.length ? Math.round((gps.reduce((a, b) => a + b, 0) / gps.length) * 100) / 100 : 0,
    avgGpsAgeSec: ages.length ? Math.round((ages.reduce((a, b) => a + b, 0) / ages.length) * 10) / 10 : null,
    ingestToGpsRatio:
      ingest.length && gps.length
        ? Math.round((ingest.reduce((a, b) => a + b, 0) / gps.reduce((a, b) => a + b, 0)) * 100) / 100
        : null,
    lastSample: samples[samples.length - 1],
  };
}

async function main() {
  console.log(JSON.stringify({ base: BASE, watchTarget, watchSec }, null, 2));
  console.log('\n=== API latency ===');

  const api = await Promise.all([
    timedFetch('GET /api/ping', `${BASE}/api/ping`, {}, 15),
    timedFetch(
      'GET /api/devices',
      `${BASE}/api/devices?windowSec=60&onlineSec=120`,
      {},
      12,
    ),
    timedFetch(
      'GET /api/map-positions',
      `${BASE}/api/map-positions?onlineSec=120&staleSec=3600`,
      {},
      12,
    ),
  ]);
  for (const row of api) console.log(JSON.stringify(row));

  console.log('\n=== Ingest + upload model ===');
  const ingest = await benchmarkIngest();
  console.log(JSON.stringify(ingest, null, 2));

  if (watchTarget) {
    console.log(`\n=== Device watch: ${watchTarget} (${watchSec}s) ===`);
    const samples = await watchDevice(watchTarget, watchSec);
    const summary = summarizeWatch(samples);
    console.log(JSON.stringify({ summary, samples: samples.slice(-5) }, null, 2));
  } else {
    const snap = await fetchDevices();
    const h6 = (snap.devices || []).find((d) => d.deviceId === 'H6');
    console.log('\n=== Fleet snapshot (no watch) ===');
    console.log(
      JSON.stringify(
        {
          health: snap.health,
          h6: h6
            ? {
                online: h6.online,
                lastSeenAgoSec: h6.lastSeenAgoSec,
                totalSamples: h6.totalSamples,
                gpsAgeSec: h6.gps?.ageSec,
              }
            : null,
          hint: 'Start a recording on H6 and re-run with --watch H6 --sec 90',
        },
        null,
        2,
      ),
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
