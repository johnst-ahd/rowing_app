const store = require('./lib/ingest-store');

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

  const windowSec = Math.min(
    300,
    Math.max(10, Number(req.query?.windowSec) || 60),
  );
  const onlineSec = Math.min(
    120,
    Math.max(5, Number(req.query?.onlineSec) || 30),
  );

  const payload = await store.listDevices({
    windowMs: windowSec * 1000,
    onlineMs: onlineSec * 1000,
  });
  if (req.query?.includeMetrics === '1') {
    payload.metrics = store.getMetrics();
  }

  return res.status(200).json({ ok: true, ...payload });
};
