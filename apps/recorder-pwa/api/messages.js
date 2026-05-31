const store = require('./lib/ingest-store');
const { validateMessageBody } = require('./lib/regatta-message');

/**
 * GET /api/messages?deviceId= — active message for recorder (public)
 * GET /api/messages — all active messages (dashboard, auth required)
 * POST /api/messages — send message to device (auth required)
 * DELETE /api/messages?deviceId= — clear active message (auth required)
 */
module.exports = async function handler(req, res) {
  store.cors(res);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    return res.status(204).end();
  }

  if (req.method === 'GET') {
    try {
      const deviceId = req.query?.deviceId;
      if (deviceId) {
        const message = await store.getActiveRegattaMessage(String(deviceId).trim());
        return res.status(200).json({
          ok: true,
          persisted: store.hasDb(),
          message,
        });
      }

      if (!store.checkAuth(req)) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
      }

      const messages = await store.listActiveRegattaMessages();
      return res.status(200).json({
        ok: true,
        persisted: store.hasDb(),
        messages,
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
      const { deviceId, text } = validateMessageBody(body);
      const message = await store.setRegattaMessage(deviceId, text);
      if (!message) {
        return res.status(503).json({
          ok: false,
          error: 'No database — add POSTGRES_URL on Vercel to store messages.',
        });
      }
      return res.status(201).json({ ok: true, message });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const deviceId = String(req.query?.deviceId ?? '').trim();
      if (!deviceId) {
        return res.status(400).json({ ok: false, error: 'deviceId required' });
      }
      const cleared = await store.clearRegattaMessage(deviceId);
      if (!cleared) {
        return res.status(404).json({ ok: false, error: 'No active message for device' });
      }
      return res.status(200).json({ ok: true, cleared: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
};
