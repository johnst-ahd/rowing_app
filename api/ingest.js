/**
 * POST /api/ingest — telemetry batches (HR, motion, combined samples).
 * Set INGEST_TOKEN in Vercel env; clients send Authorization: Bearer <token>.
 *
 * Storage: in-memory ring per session for dev; replace with @vercel/kv in production.
 */

const MAX_SAMPLES_PER_REQUEST = 500;
const MAX_SESSIONS = 200;

/** @type {Map<string, { deviceId: string, athleteId?: string, samples: object[], updatedAt: number }>} */
const sessions = globalThis.__rnzIngestSessions ?? new Map();
globalThis.__rnzIngestSessions = sessions;

function trimSessions() {
  if (sessions.size <= MAX_SESSIONS) return;
  const sorted = [...sessions.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  const remove = sorted.length - MAX_SESSIONS;
  for (let i = 0; i < remove; i++) sessions.delete(sorted[i][0]);
}

function checkAuth(req) {
  const expected = process.env.INGEST_TOKEN || '';
  if (!expected) return true;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return token === expected;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (!checkAuth(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (req.method === 'GET') {
    const sessionId = req.query?.sessionId;
    if (!sessionId) {
      return res.status(400).json({ ok: false, error: 'sessionId required' });
    }
    const row = sessions.get(String(sessionId));
    if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
    return res.status(200).json({ ok: true, ...row });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ ok: false, error: 'Invalid JSON' });
    }
  }

  const sessionId = body?.sessionId;
  const deviceId = body?.deviceId;
  const samples = body?.samples;

  if (!sessionId || !deviceId || !Array.isArray(samples)) {
    return res.status(400).json({
      ok: false,
      error: 'sessionId, deviceId, and samples[] required',
    });
  }

  if (samples.length > MAX_SAMPLES_PER_REQUEST) {
    return res.status(413).json({
      ok: false,
      error: `Max ${MAX_SAMPLES_PER_REQUEST} samples per request`,
    });
  }

  const key = String(sessionId);
  const existing = sessions.get(key) || {
    deviceId: String(deviceId),
    athleteId: body.athleteId ? String(body.athleteId) : undefined,
    samples: [],
    updatedAt: Date.now(),
  };

  existing.deviceId = String(deviceId);
  if (body.athleteId) existing.athleteId = String(body.athleteId);
  existing.samples.push(...samples);
  if (existing.samples.length > 50000) {
    existing.samples = existing.samples.slice(-50000);
  }
  existing.updatedAt = Date.now();
  sessions.set(key, existing);
  trimSessions();

  return res.status(200).json({
    ok: true,
    received: samples.length,
    sessionId: key,
    total: existing.samples.length,
  });
}
