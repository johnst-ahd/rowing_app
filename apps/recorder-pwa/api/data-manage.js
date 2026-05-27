const store = require('./lib/ingest-store');

const DELETE_ALL_CONFIRM = 'DELETE ALL RNZ DATA';

/**
 * GET /api/data-manage — storage stats + security info
 * POST /api/data-manage — delete stored telemetry (requires INGEST_TOKEN when set)
 *
 * Body: { action, sessionId?, uniqueId?, from?, to?, confirm? }
 */
module.exports = async function handler(req, res) {
  store.cors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (!store.checkAuth(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (req.method === 'GET') {
    const stats = await store.getStorageStats();
    return res.status(200).json({
      ok: true,
      persisted: store.hasDb(),
      stats,
      security: store.getDataSecurityInfo(),
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!store.hasDb()) {
    return res.status(503).json({
      ok: false,
      error: 'No database — add POSTGRES_URL on Vercel to store or delete history.',
    });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ ok: false, error: 'Invalid JSON' });
    }
  }

  const action = body?.action;
  if (!action) {
    return res.status(400).json({ ok: false, error: 'action required' });
  }

  try {
    if (action === 'deleteSession') {
      const sessionId = body?.sessionId;
      if (!sessionId) {
        return res.status(400).json({ ok: false, error: 'sessionId required' });
      }
      const result = await store.deleteStoredSession(String(sessionId));
      return res.status(200).json({ ok: true, action, result });
    }

    if (action === 'deleteDevice') {
      const uniqueId = body?.uniqueId;
      if (!uniqueId) {
        return res.status(400).json({ ok: false, error: 'uniqueId required' });
      }
      const result = await store.deleteStoredDevice(String(uniqueId));
      return res.status(200).json({ ok: true, action, result });
    }

    if (action === 'deleteRange') {
      const uniqueId = body?.uniqueId;
      const from = body?.from;
      const to = body?.to;
      if (!uniqueId || !from || !to) {
        return res.status(400).json({
          ok: false,
          error: 'uniqueId, from, and to required (ISO 8601)',
        });
      }
      const result = await store.deleteStoredRange(
        String(uniqueId),
        String(from),
        String(to),
      );
      return res.status(200).json({ ok: true, action, result });
    }

    if (action === 'deleteAll') {
      if (body?.confirm !== DELETE_ALL_CONFIRM) {
        return res.status(400).json({
          ok: false,
          error: `confirm must be exactly: ${DELETE_ALL_CONFIRM}`,
        });
      }
      const result = await store.deleteAllStoredData();
      return res.status(200).json({ ok: true, action, result });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('[data-manage]', err);
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
