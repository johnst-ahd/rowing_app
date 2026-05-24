const LS_TOKEN = 'rnz_dashboard_token';
const LS_POLL = 'rnz_dashboard_poll_ms';
const LS_STALE = 'rnz_dashboard_stale_sec';

const MAP_CENTER = [-37.9305, 175.5485];
const MAP_ZOOM = 12;
const ONLINE_SEC = 120;
/** GPS fix age thresholds (seconds) for map/card colours. */
const GPS_LIVE_SEC = 30;
const GPS_STALE_SEC = 300;

const $ = (sel) => document.querySelector(sel);

let map = null;
let markersLayer = null;
/** @type {Map<string, L.Marker>} */
const deviceMarkers = new Map();
let mapDidFit = false;

function apiBase() {
  return window.location.origin;
}

function headers() {
  const token = $('#token')?.value?.trim() || localStorage.getItem(LS_TOKEN) || '';
  const h = { Accept: 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function savePrefs() {
  const token = $('#token')?.value?.trim();
  if (token) localStorage.setItem(LS_TOKEN, token);
  localStorage.setItem(LS_POLL, String($('#pollMs')?.value || 2000));
  localStorage.setItem(LS_STALE, String($('#staleSec')?.value || 3600));
}

function staleSec() {
  return Number($('#staleSec')?.value || localStorage.getItem(LS_STALE) || 3600);
}

function fmtHz(v) {
  if (v == null || v === 0) return '—';
  return `${v} Hz`;
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

function initMap() {
  const el = $('#fleetMap');
  if (!el || map || typeof L === 'undefined') return;

  map = L.map(el, { zoomControl: true }).setView(MAP_CENTER, MAP_ZOOM);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(map);

  markersLayer = L.layerGroup().addTo(map);
}

/** @returns {'live' | 'amber' | 'lost'} */
function gpsFixState(fixAgeSec) {
  const age = Number(fixAgeSec);
  if (!Number.isFinite(age)) return 'lost';
  if (age <= GPS_LIVE_SEC) return 'live';
  if (age <= GPS_STALE_SEC) return 'amber';
  return 'lost';
}

function gpsStatusLabel(state) {
  if (state === 'live') return 'GPS live (≤30s)';
  if (state === 'amber') return 'GPS delayed (30s–5min)';
  return 'Last known (>5min)';
}

function markerIcon(state) {
  return L.divIcon({
    className: `map-marker-wrap map-marker-wrap--${state}`,
    html: `<span class="map-marker map-marker--${state}" aria-hidden="true"></span>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

function popupHtml(p) {
  const state = gpsFixState(p.fixAgeSec);
  const status = gpsStatusLabel(state);
  const hr = p.hr != null ? `<br>HR: ${p.hr} bpm` : '';
  return `<div class="map-popup"><strong>${esc(p.deviceId)}</strong><br>${status}<br>GPS fix ${p.fixAgeSec}s ago · seen ${p.lastSeenAgoSec}s ago${hr}</div>`;
}

function updateMap(positions) {
  initMap();
  if (!map || !markersLayer) return;

  const seen = new Set();
  const latlngs = [];

  for (const p of positions) {
    if (p.latitude == null || p.longitude == null) continue;
    seen.add(p.deviceId);
    latlngs.push([p.latitude, p.longitude]);

    const latlng = L.latLng(p.latitude, p.longitude);
    let marker = deviceMarkers.get(p.deviceId);
    const state = gpsFixState(p.fixAgeSec);
    const icon = markerIcon(state);

    if (marker) {
      marker.setLatLng(latlng);
      marker.setIcon(icon);
      marker.setPopupContent(popupHtml(p));
    } else {
      marker = L.marker(latlng, { icon }).bindPopup(popupHtml(p));
      markersLayer.addLayer(marker);
      deviceMarkers.set(p.deviceId, marker);
    }
  }

  for (const [id, marker] of deviceMarkers) {
    if (!seen.has(id)) {
      markersLayer.removeLayer(marker);
      deviceMarkers.delete(id);
    }
  }

  const statusEl = $('#mapStatus');
  let liveN = 0;
  let amberN = 0;
  let lostN = 0;
  for (const p of positions) {
    if (p.latitude == null || p.longitude == null) continue;
    const s = gpsFixState(p.fixAgeSec);
    if (s === 'live') liveN++;
    else if (s === 'amber') amberN++;
    else lostN++;
  }
  if (statusEl) {
    statusEl.textContent =
      positions.length === 0
        ? 'No GPS positions in the selected time window.'
        : `${liveN} live · ${amberN} delayed · ${lostN} last known`;
  }

  if (latlngs.length === 1 && !mapDidFit) {
    map.setView(latlngs[0], Math.max(map.getZoom(), 14));
    mapDidFit = true;
  } else if (latlngs.length > 1) {
    map.fitBounds(L.latLngBounds(latlngs), { padding: [36, 36], maxZoom: 15 });
    mapDidFit = true;
  }
}

async function fetchMapPositions() {
  const url = `${apiBase()}/api/map-positions?onlineSec=${ONLINE_SEC}&staleSec=${staleSec()}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Map ${res.status} ${text.slice(0, 80)}`);
  }
  const data = await res.json();
  updateMap(Array.isArray(data.positions) ? data.positions : []);
  return data;
}

function renderDevice(d) {
  const card = document.createElement('article');
  const gpsState = gpsFixState(d.gps?.ageSec ?? d.lastSeenAgoSec);
  card.className = `device-card device-card--${gpsState}`;

  const gps = d.gps || {};
  const hr = d.hr || {};
  const motion = d.motion || {};

  const badgeClass =
    gpsState === 'live'
      ? 'badge-pill--live'
      : gpsState === 'amber'
        ? 'badge-pill--amber'
        : 'badge-pill--lost';
  const badgeLabel =
    gpsState === 'live' ? 'GPS live' : gpsState === 'amber' ? 'GPS delayed' : 'Last known';

  const coords =
    gps.last?.lat != null
      ? `${gps.last.lat.toFixed(5)}, ${gps.last.lon.toFixed(5)}`
      : null;

  card.innerHTML = `
    <div class="device-head">
      <div>
        <h2>${esc(d.deviceId)}</h2>
        <div class="sub">${d.athleteId ? esc(d.athleteId) : 'No athlete ID'} · session ${esc(d.sessionId.slice(0, 8))}…</div>
      </div>
      <span class="badge-pill ${badgeClass}">${badgeLabel}</span>
    </div>
    <div class="sensors">
      <div class="sensor ${gps.present ? 'present' : 'absent'}">
        <div class="name">GPS</div>
        <div class="rate">${gps.present ? fmtHz(gps.rateHz) : '—'}</div>
        <div class="detail">${gps.present ? `${gps.count} fixes / ${d.windowSec || 60}s` : 'No data'}</div>
      </div>
      <div class="sensor ${hr.present ? 'present' : 'absent'}">
        <div class="name">Heart rate</div>
        <div class="rate">${hr.present ? fmtHz(hr.rateHz) : '—'}</div>
        <div class="detail">${hr.last ? `${hr.last.bpm} bpm · ${hr.ageSec}s ago` : 'Not present'}</div>
      </div>
      <div class="sensor ${motion.present ? 'present' : 'absent'}">
        <div class="name">Accelerometer</div>
        <div class="rate">${motion.present ? fmtHz(motion.rateHz) : '—'}</div>
        <div class="detail">${motion.present ? `${motion.count} samples` : 'Not present'}</div>
      </div>
    </div>
    <div class="meta-row">
      <span>Ingest <strong>${fmtHz(d.ingestRateHz)}</strong></span>
      <span>Total samples <strong>${d.totalSamples}</strong></span>
      <span>Last seen <strong>${d.lastSeenAgoSec}s ago</strong></span>
    </div>
    ${coords ? `<div class="coords">${coords}${gps.ageSec != null ? ` · GPS ${gps.ageSec}s ago` : ''}</div>` : ''}
  `;
  return card;
}

async function poll() {
  const status = $('#pollStatus');
  const grid = $('#devicesGrid');
  const windowSec = $('#windowSec')?.value || 60;

  try {
    const devicesUrl = `${apiBase()}/api/devices?windowSec=${encodeURIComponent(windowSec)}&onlineSec=${ONLINE_SEC}`;
    const [devicesRes, mapResult] = await Promise.allSettled([
      fetch(devicesUrl, { headers: headers() }),
      fetchMapPositions(),
    ]);

    if (devicesRes.status !== 'fulfilled') {
      throw devicesRes.reason;
    }
    const res = devicesRes.value;
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401) {
        throw new Error('401 Unauthorized — ingest token on this page must match INGEST_TOKEN in Vercel.');
      }
      throw new Error(`${res.status} ${text.slice(0, 120)}`);
    }
    const data = await res.json();

    if (mapResult.status === 'rejected') {
      const mapStatus = $('#mapStatus');
      if (mapStatus) {
        mapStatus.textContent = `Map error: ${mapResult.reason?.message || mapResult.reason}`;
      }
    }

    const warnEl = $('#storageWarning');
    if (warnEl) {
      if (data.warning) {
        warnEl.hidden = false;
        warnEl.textContent = data.warning;
      } else {
        warnEl.hidden = true;
        warnEl.textContent = '';
      }
    }

    $('#activeCount').textContent = `Online: ${data.activeCount ?? 0}`;
    $('#deviceCount').textContent = `Devices: ${data.deviceCount ?? 0}`;
    $('#windowLabel').textContent = `Window: ${data.windowSec ?? windowSec}s`;

    grid.innerHTML = '';
    if (!data.devices?.length) {
      const hint = data.persisted
        ? 'No devices in the last window. Check the phone is recording and Device ID matches.'
        : 'No devices visible — add POSTGRES_URL on Vercel (Storage → Postgres), redeploy, then record again.';
      grid.innerHTML = `<p class="empty">${hint}</p>`;
    } else {
      for (const d of data.devices) {
        d.windowSec = data.windowSec;
        grid.appendChild(renderDevice(d));
      }
    }

    const t = new Date(data.polledAt || Date.now()).toLocaleTimeString();
    status.textContent = `Updated ${t} · ${data.devices?.length ?? 0} device(s)`;
    status.classList.remove('err');
  } catch (e) {
    status.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
    status.classList.add('err');
  }
}

let timer = null;

function startPolling() {
  savePrefs();
  if (timer) clearInterval(timer);
  void poll();
  const ms = Number($('#pollMs')?.value || 2000);
  timer = setInterval(() => void poll(), ms);
}

function init() {
  const savedToken = localStorage.getItem(LS_TOKEN);
  const savedPoll = localStorage.getItem(LS_POLL);
  const savedStale = localStorage.getItem(LS_STALE);
  if (savedToken && $('#token')) $('#token').value = savedToken;
  if (savedPoll && $('#pollMs')) $('#pollMs').value = savedPoll;
  if (savedStale && $('#staleSec')) $('#staleSec').value = savedStale;

  initMap();

  $('#refreshBtn')?.addEventListener('click', () => void poll());
  $('#applyBtn')?.addEventListener('click', startPolling);
  ['#token', '#pollMs', '#windowSec', '#staleSec'].forEach((sel) => {
    $(sel)?.addEventListener('change', savePrefs);
  });

  startPolling();
}

init();
