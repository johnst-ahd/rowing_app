const store = require('./lib/ingest-store');

/**
 * GET /api/geofences — list boat park / economy zones (recorder + dashboard)
 * POST /api/geofences — create geofence (dashboard, auth required)
 * DELETE /api/geofences?id= — remove geofence
 */
module.exports = async function handler(req, res) {
  store.cors(res);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    return res.status(204).end();
  }

  if (req.method === 'GET') {
    try {
      const geofences = await store.listGeofences();
      return res.status(200).json({
        ok: true,
        persisted: store.hasDb(),
        geofences,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  }

  if (!store.checkAuth(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};
      const geofence = await store.createGeofence(body);
      if (!geofence) {
        return res.status(503).json({
          ok: false,
          error: 'No database — add POSTGRES_URL on Vercel to store geofences.',
        });
      }
      return res.status(201).json({ ok: true, geofence });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const id = req.query?.id;
      const deleted = await store.deleteGeofence(id);
      if (!deleted) {
        return res.status(404).json({ ok: false, error: 'Geofence not found' });
      }
      return res.status(200).json({ ok: true, deleted: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
};
