const store = require('./lib/ingest-store');

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    ok: true,
    service: 'rowing-recorder',
    time: Date.now(),
    persisted: store.hasDb(),
    storage: store.hasDb() ? 'postgres' : 'memory',
  });
};
