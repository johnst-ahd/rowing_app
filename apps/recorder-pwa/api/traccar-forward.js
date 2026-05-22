/**
 * Proxy OsmAnd GPS uploads to Traccar (browser cannot call :5055 due to CORS).
 * GET /api/traccar-forward?url=<encoded full OsmAnd URL>
 */

function allowedHost(hostname) {
  const host = String(hostname).toLowerCase();
  const list = (process.env.TRACCAR_ALLOWED_HOSTS || 'traccar.com')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.some((h) => host === h || host.endsWith(`.${h}`));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'GET only' });
  }

  const raw = req.query?.url;
  if (!raw) {
    return res.status(400).json({ ok: false, error: 'url query required' });
  }

  let target;
  try {
    target = new URL(String(raw));
  } catch {
    return res.status(400).json({ ok: false, error: 'Invalid url' });
  }

  if (!allowedHost(target.hostname)) {
    return res.status(403).json({ ok: false, error: 'Host not allowed' });
  }

  try {
    const upstream = await fetch(target.toString(), {
      method: 'GET',
      headers: { Accept: '*/*' },
    });
    const text = await upstream.text().catch(() => '');
    if (!upstream.ok) {
      return res.status(502).json({
        ok: false,
        error: `Traccar ${upstream.status}`,
        detail: text.slice(0, 200),
      });
    }
    return res.status(200).json({ ok: true, traccarStatus: upstream.status });
  } catch (e) {
    return res.status(502).json({
      ok: false,
      error: e instanceof Error ? e.message : 'Forward failed',
    });
  }
};
