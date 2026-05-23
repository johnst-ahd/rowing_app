const store = require('./lib/ingest-store');

/**
 * GET /api/history — route replay (Traccar-shaped positions array)
 *   ?deviceId=123&from=ISO&to=ISO   (numeric id from registry)
 *   ?uniqueId=CREW-01&from=ISO&to=ISO
 *
 * GET /api/history?list=sessions&uniqueId=CREW-01 — session list
 */
module.exports = async function handler(req, res) {
  store.cors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!store.checkAuth(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (req.query?.list === 'sessions') {
    const uniqueId = req.query?.uniqueId || null;
    const sessions = await store.listSessionsHistory(uniqueId);
    return res.status(200).json({
      ok: true,
      persisted: store.hasDb(),
      sessions,
    });
  }

  const from = req.query?.from;
  const to = req.query?.to;
  if (!from || !to) {
    return res.status(400).json({
      ok: false,
      error: 'from and to required (ISO 8601), or list=sessions',
    });
  }

  const deviceId = req.query?.deviceId;
  const uniqueId = req.query?.uniqueId;
  if (!deviceId && !uniqueId) {
    return res.status(400).json({
      ok: false,
      error: 'deviceId (numeric) or uniqueId required',
    });
  }

  const positions = await store.getRouteHistory(deviceId, uniqueId, from, to);
  return res.status(200).json(positions);
};
