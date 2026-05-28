/** Reject null island, out-of-range, and very poor accuracy fixes. */
const MAX_GPS_ACCURACY_M = 150;

/**
 * @param {number} lat
 * @param {number} lon
 */
function isValidGpsCoords(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (Math.abs(lat) < 1e-4 && Math.abs(lon) < 1e-4) return false;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
  return true;
}

/**
 * @param {{ lat?: unknown, lon?: unknown, acc?: unknown } | null | undefined} gps
 */
function isValidGps(gps) {
  if (!gps) return false;
  const lat = Number(gps.lat);
  const lon = Number(gps.lon);
  if (!isValidGpsCoords(lat, lon)) return false;
  const acc = gps.acc != null ? Number(gps.acc) : null;
  if (acc != null && Number.isFinite(acc) && acc > MAX_GPS_ACCURACY_M) return false;
  return true;
}

/**
 * Drop invalid GPS from a sample; omit sample if nothing else remains.
 * @param {object} sample
 */
function sanitizeSample(sample) {
  if (!sample || typeof sample !== 'object') return null;
  const t = Number(sample.t);
  if (!Number.isFinite(t)) return null;

  if (sample.gps && !isValidGps(sample.gps)) {
    const { gps, ...rest } = sample;
    const hasPayload =
      rest.motion != null || rest.hr != null || rest.derived != null;
    if (!hasPayload) return null;
    return { ...rest, t };
  }

  return { ...sample, t };
}

/**
 * @param {object[]} samples
 */
function sanitizeTelemetrySamples(samples) {
  const out = [];
  for (const s of samples) {
    const clean = sanitizeSample(s);
    if (clean) out.push(clean);
  }
  return out;
}

module.exports = {
  MAX_GPS_ACCURACY_M,
  isValidGpsCoords,
  isValidGps,
  sanitizeSample,
  sanitizeTelemetrySamples,
};
