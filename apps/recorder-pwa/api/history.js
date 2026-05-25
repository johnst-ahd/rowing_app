const store = require('./lib/ingest-store');

/**
 * GET /api/history — route replay (Traccar-shaped positions array)
 *   ?deviceId=123&from=ISO&to=ISO   (numeric id from registry)
 *   ?uniqueId=CREW-01&from=ISO&to=ISO
 *
 * GET /api/history?list=sessions&uniqueId=CREW-01 — session list
 * GET /api/history?list=devices — devices with stored history
 * GET /api/history?format=dashboard&uniqueId=&from=&to= — track + charts data
 * GET /api/history?format=dashboard&sessionId= — load one session
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

  if (req.query?.list === 'devices') {
    const devices = await store.listHistoryDevices();
    return res.status(200).json({
      ok: true,
      persisted: store.hasDb(),
      devices,
    });
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

  if (req.query?.format === 'dashboard') {
    if (!store.hasDb()) {
      return res.status(503).json({
        ok: false,
        error: 'No database — add POSTGRES_URL on Vercel to search history.',
      });
    }

    const sessionId = req.query?.sessionId;
    let payload = null;
    if (sessionId) {
      payload = await store.getDashboardHistoryBySession(String(sessionId));
    } else {
      const from = req.query?.from;
      const to = req.query?.to;
      const uniqueId = req.query?.uniqueId;
      if (!from || !to || !uniqueId) {
        return res.status(400).json({
          ok: false,
          error: 'uniqueId, from, and to required (or sessionId)',
        });
      }
      payload = await store.getDashboardHistory(
        String(uniqueId),
        String(from),
        String(to),
      );
    }

    if (!payload) {
      return res.status(404).json({ ok: false, error: 'No data for this query' });
    }
    return res.status(200).json({ ok: true, persisted: true, ...payload });
  }

  const from = req.query?.from;
  const to = req.query?.to;
  if (!from || !to) {
    return res.status(400).json({
      ok: false,
      error: 'from and to required (ISO 8601), or list=sessions / format=dashboard',
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
