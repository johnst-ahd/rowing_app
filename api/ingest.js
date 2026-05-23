const store = require('./lib/ingest-store');

module.exports = async function handler(req, res) {
  store.cors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (!store.checkAuth(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (req.method === 'GET') {
    const sessionId = req.query?.sessionId;
    if (!sessionId) {
      return res.status(400).json({ ok: false, error: 'sessionId required' });
    }
    const row = await store.getSession(sessionId);
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

  if (samples.length > store.MAX_SAMPLES_PER_REQUEST) {
    return res.status(413).json({
      ok: false,
      error: `Max ${store.MAX_SAMPLES_PER_REQUEST} samples per request`,
    });
  }

  const result = await store.recordBatch(
    sessionId,
    deviceId,
    body.athleteId,
    samples,
  );

  const body = {
    ok: true,
    sessionId: String(sessionId),
    received: result.received,
    total: result.total,
    persisted: Boolean(result.persisted),
  };
  if (result.persistError) {
    body.persistError = String(result.persistError).slice(0, 300);
  }
  return res.status(200).json(body);
};
