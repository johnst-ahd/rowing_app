const LS_TOKEN = 'rnz_dashboard_token';
const LS_POLL = 'rnz_dashboard_poll_ms';

const $ = (sel) => document.querySelector(sel);

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
}

function fmtHz(v) {
  if (v == null || v === 0) return '—';
  return `${v} Hz`;
}

function renderDevice(d) {
  const card = document.createElement('article');
  card.className = `device-card ${d.online ? 'online' : ''}`;

  const gps = d.gps || {};
  const hr = d.hr || {};
  const motion = d.motion || {};

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
      <span class="badge ${d.online ? 'badge-online' : 'badge-offline'}">${d.online ? 'Online' : 'Offline'}</span>
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

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

async function poll() {
  const status = $('#pollStatus');
  const grid = $('#devicesGrid');
  const windowSec = $('#windowSec')?.value || 60;

  try {
    const url = `${apiBase()}/api/devices?windowSec=${encodeURIComponent(windowSec)}`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status} ${text.slice(0, 120)}`);
    }
    const data = await res.json();

    $('#activeCount').textContent = String(data.activeCount ?? 0);
    $('#deviceCount').textContent = String(data.deviceCount ?? 0);
    $('#windowLabel').textContent = String(data.windowSec ?? windowSec);

    grid.innerHTML = '';
    if (!data.devices?.length) {
      grid.innerHTML =
        '<p class="empty">No devices yet. Start a recording session on a phone with this deployment’s ingest URL.</p>';
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
  if (savedToken && $('#token')) $('#token').value = savedToken;
  if (savedPoll && $('#pollMs')) $('#pollMs').value = savedPoll;

  $('#refreshBtn')?.addEventListener('click', () => void poll());
  $('#applyBtn')?.addEventListener('click', startPolling);
  ['#token', '#pollMs', '#windowSec'].forEach((sel) => {
    $(sel)?.addEventListener('change', savePrefs);
  });

  startPolling();
}

init();
