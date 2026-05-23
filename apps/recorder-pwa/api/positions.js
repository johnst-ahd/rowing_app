const store = require('./lib/ingest-store');

/** GET /api/positions — latest GPS per device from ingest (replaces Traccar for maps). */
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

  const onlineSec = Math.min(
    120,
    Math.max(5, Number(req.query?.onlineSec) || 30),
  );

  const payload = store.getPositionsSnapshot(onlineSec * 1000);
  return res.status(200).json({ ok: true, ...payload });
};
