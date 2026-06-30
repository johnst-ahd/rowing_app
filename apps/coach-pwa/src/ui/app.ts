import '../styles.css';
import {
  fetchDevices,
  fetchMapPositions,
  listSessions,
  loadSessionTrack,
  type FleetDevice,
  type MapPosition,
} from '../lib/api';
import {
  getNativeMonitoringStatus,
  IS_NATIVE,
  startNativeMonitoring,
  stopNativeMonitoring,
} from '../lib/native-monitor';
import { loadSettings, saveSettings, type CoachSettings } from '../lib/settings';

type Tab = 'live' | 'history' | 'settings';

declare const L: typeof import('leaflet');

/** Resolve static assets for web (/) and Capacitor (./). */
function asset(path: string): string {
  const clean = path.replace(/^\//, '');
  return `${import.meta.env.BASE_URL}${clean}`;
}

export function mountApp(root: HTMLElement): void {
  let settings = loadSettings();
  let tab: Tab = 'live';
  let monitoring = false;
  let serviceRunning = false;
  let devices: FleetDevice[] = [];
  let positions: MapPosition[] = [];
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let map: L.Map | null = null;
  let markersLayer: L.LayerGroup | null = null;
  /** @type {Map<string, L.Marker>} */
  const markers = new Map<string, L.Marker>();
  let historyMap: L.Map | null = null;
  let historyLine: L.Polyline | null = null;
  let sessions: { session_id: string; started_at: string }[] = [];

  const capsizeCount = () =>
    devices.filter((d) => d.rowing?.capsize || positions.some((p) => p.deviceId === d.deviceId && p.capsize)).length;

  async function refreshMonitoringStatus() {
    const st = await getNativeMonitoringStatus();
    monitoring = st.active;
    serviceRunning = st.serviceRunning;
  }

  async function pollLive() {
    if (!settings.apiBaseUrl) return;
    try {
      const [dev, pos] = await Promise.all([
        fetchDevices(settings),
        fetchMapPositions(settings),
      ]);
      devices = mergeCoachDevicesWithMap(dev, pos);
      positions = pos;
      render();
      updateMap();
      setStatus(`Updated · ${devices.length} device(s)`, false);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), true);
    }
  }

  function mergeCoachDevicesWithMap(
    apiDevices: FleetDevice[],
    mapPositions: MapPosition[],
  ): FleetDevice[] {
    const mapById = new Map(mapPositions.map((p) => [p.deviceId, p]));
    const byId = new Map<string, FleetDevice>();
    for (const d of apiDevices) {
      const p = mapById.get(d.deviceId);
      byId.set(d.deviceId, {
        ...d,
        gpsAgeSec: p?.fixAgeSec ?? d.gps?.ageSec ?? undefined,
      });
    }
    for (const p of mapPositions) {
      if (!byId.has(p.deviceId)) {
        byId.set(p.deviceId, {
          deviceId: p.deviceId,
          online: true,
          lastSeenAgoSec: p.lastSeenAgoSec ?? p.fixAgeSec,
          gpsAgeSec: p.fixAgeSec,
          rowing: { capsize: p.capsize, strokeRate: p.strokeRate ?? null },
        });
      }
    }
    return [...byId.values()];
  }

  function setStatus(msg: string, err = false) {
    const el = root.querySelector('[data-poll-status]');
    if (el) {
      el.textContent = msg;
      el.classList.toggle('err', err);
    }
  }

  function destroyMap() {
    if (map) {
      map.remove();
      map = null;
      markersLayer = null;
      markers.clear();
    }
  }

  function ensureMap() {
    if (typeof L === 'undefined') return;
    const el = root.querySelector('#coachMap') as HTMLElement | null;
    if (!el) return;
    if (map && map.getContainer() !== el) {
      destroyMap();
    }
    if (map) return;
    map = L.map(el).setView([-37.93, 175.55], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);
    markersLayer = L.layerGroup().addTo(map);
  }

  function updateMap() {
    ensureMap();
    if (!map || !markersLayer) return;
    const seen = new Set<string>();
    for (const p of positions) {
      if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue;
      seen.add(p.deviceId);
      const latlng = L.latLng(p.latitude, p.longitude);
      const fixAge = p.fixAgeSec;
      const cap = Boolean(p.capsize);
      const amber = !cap && fixAge != null && fixAge > 30 && fixAge <= 300;
      const color = cap ? '#ef4444' : amber ? '#fbbf24' : '#38bdf8';
      const icon = L.divIcon({
        className: cap ? 'coach-marker capsize' : amber ? 'coach-marker amber' : 'coach-marker',
        html: `<span style="background:${color};width:14px;height:14px;border-radius:50%;display:block;border:2px solid #fff"></span>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      });
      let m = markers.get(p.deviceId);
      if (m) {
        m.setLatLng(latlng);
        m.setIcon(icon);
      } else {
        m = L.marker(latlng, { icon }).bindPopup(p.deviceId);
        markersLayer.addLayer(m);
        markers.set(p.deviceId, m);
      }
    }
    for (const [id, m] of markers) {
      if (!seen.has(id)) {
        markersLayer.removeLayer(m);
        markers.delete(id);
      }
    }
    setTimeout(() => map?.invalidateSize(), 100);
  }

  function drawLineChart(
    canvas: HTMLCanvasElement,
    points: { x: number; y: number }[],
    opts: { title: string; xLabel: string; yLabel: string; color: string },
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#f1f5f9';
    ctx.font = '12px system-ui';
    ctx.fillText(opts.title, 8, 16);
    if (points.length < 2) {
      ctx.fillStyle = '#94a3b8';
      ctx.fillText('No data', 8, 36);
      return;
    }
    const pad = 28;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const sx = (x: number) =>
      pad + ((x - minX) / Math.max(maxX - minX, 1e-6)) * (w - pad * 2);
    const sy = (y: number) =>
      h - pad - ((y - minY) / Math.max(maxY - minY, 1e-6)) * (h - pad * 2);
    ctx.strokeStyle = opts.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((p, i) => {
      const px = sx(p.x);
      const py = sy(p.y);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(opts.xLabel, w - 60, h - 6);
    ctx.save();
    ctx.translate(10, h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(opts.yLabel, 0, 0);
    ctx.restore();
  }

  function trackToDistanceSpeed(track: Awaited<ReturnType<typeof loadSessionTrack>>) {
    const withGps = track.filter((p) => p.lat != null && p.lon != null && p.speed != null);
    let dist = 0;
    const points: { x: number; y: number; t: number }[] = [];
    for (let i = 0; i < withGps.length; i++) {
      const p = withGps[i];
      if (i > 0) {
        const prev = withGps[i - 1];
        const dt = (p.t - prev.t) / 1000;
        if (dt > 0 && dt < 120 && p.speed != null) {
          dist += p.speed * dt;
        }
      }
      points.push({ x: dist, y: p.speed ?? 0, t: p.t });
    }
    return points;
  }

  async function loadHistorySession(sessionId: string) {
    const track = await loadSessionTrack(settings, sessionId);
    const distSpeed = trackToDistanceSpeed(track);
    const timeSpeed = track
      .filter((p) => p.speed != null)
      .map((p) => ({ x: (p.t - track[0].t) / 1000, y: p.speed ?? 0 }));

    const speedTime = root.querySelector('#chartSpeedTime') as HTMLCanvasElement | null;
    const speedDist = root.querySelector('#chartSpeedDist') as HTMLCanvasElement | null;
    if (speedTime) {
      speedTime.width = speedTime.clientWidth * 2;
      speedTime.height = 320;
      drawLineChart(
        speedTime,
        timeSpeed.map((p) => ({ x: p.x, y: p.y })),
        { title: 'Speed vs time', xLabel: 's', yLabel: 'm/s', color: '#38bdf8' },
      );
    }
    if (speedDist) {
      speedDist.width = speedDist.clientWidth * 2;
      speedDist.height = 320;
      drawLineChart(
        speedDist,
        distSpeed.map((p) => ({ x: p.x, y: p.y })),
        { title: 'Speed vs distance', xLabel: 'm', yLabel: 'm/s', color: '#a78bfa' },
      );
    }

    const mapEl = root.querySelector('#historyMap') as HTMLElement | null;
    if (mapEl && typeof L !== 'undefined') {
      if (!historyMap) {
        historyMap = L.map(mapEl);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(historyMap);
      }
      if (historyLine) historyMap.removeLayer(historyLine);
      const latlngs = track
        .filter((p) => p.lat != null && p.lon != null)
        .map((p) => [p.lat!, p.lon!] as [number, number]);
      if (latlngs.length >= 2) {
        historyLine = L.polyline(latlngs, { color: '#38bdf8', weight: 4 }).addTo(historyMap);
        historyMap.fitBounds(historyLine.getBounds(), { padding: [24, 24] });
      }
      setTimeout(() => historyMap?.invalidateSize(), 120);
    }
  }

  async function onStartMonitoring() {
    settings = loadSettings();
    if (!settings.apiBaseUrl) {
      setStatus('Set API URL in Settings first', true);
      tab = 'settings';
      render();
      return;
    }
    if (IS_NATIVE) {
      await startNativeMonitoring(settings.apiBaseUrl, settings.ingestToken);
    }
    monitoring = true;
    serviceRunning = IS_NATIVE;
    startPollTimer();
    render();
    void pollLive();
  }

  async function onStopMonitoring() {
    if (IS_NATIVE) {
      await stopNativeMonitoring();
    }
    monitoring = false;
    serviceRunning = false;
    stopPollTimer();
    render();
  }

  function startPollTimer() {
    stopPollTimer();
    pollTimer = setInterval(() => void pollLive(), 3000);
  }

  function stopPollTimer() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function render() {
    const caps = capsizeCount();
    root.innerHTML = `
      <div class="coach-app">
        <header class="hub-topbar hub-topbar--manager">
          <div class="hub-topbar-inner">
            <div class="hub-topbar-brands">
              <img src="${asset('assets/crewsight/crewsight-logo-full-manager-color.png')}" alt="CrewSight Manager" class="hub-crewsight-logo hub-crewsight-logo--manager" width="200" height="200" />
            </div>
            <p class="hub-tagline">Fleet monitor${IS_NATIVE ? ' · Native app' : ''} — background capsize alerts when monitoring</p>
          </div>
        </header>
        ${caps > 0 ? `<div class="capsize-banner" role="alert">${caps} CAPSIZE — check crew now</div>` : ''}
        <div class="coach-monitor-bar ${monitoring ? 'monitoring' : ''}">
          <div class="status-line ${monitoring ? 'on' : ''}">
            ${monitoring
              ? serviceRunning
                ? '● Monitoring fleet (background active)'
                : '● Monitoring (foreground poll only)'
              : 'Monitoring off — no background alerts'}
          </div>
          ${monitoring
            ? `<button type="button" class="coach-btn coach-btn--danger" data-stop-monitor>Stop monitoring</button>`
            : `<button type="button" class="coach-btn coach-btn--primary" data-start-monitor>Start monitoring</button>`}
        </div>
        <nav class="coach-tabs">
          <button type="button" class="coach-tab ${tab === 'live' ? 'active' : ''}" data-tab="live">Live</button>
          <button type="button" class="coach-tab ${tab === 'history' ? 'active' : ''}" data-tab="history">History</button>
          <button type="button" class="coach-tab ${tab === 'settings' ? 'active' : ''}" data-tab="settings">Settings</button>
        </nav>
        <section class="coach-panel" data-panel="live" ${tab === 'live' ? '' : 'hidden'}>
          <p class="poll-line" data-poll-status>—</p>
          <div id="coachMap" class="coach-map"></div>
          <ul class="device-list">${devices
            .map((d) => {
              const cap = Boolean(d.rowing?.capsize);
              const spm =
                d.rowing?.strokeRateValid && d.rowing.strokeRate != null
                  ? `${Math.round(d.rowing.strokeRate)} spm`
                  : '—';
              const gpsAge = d.gpsAgeSec;
              const gpsLabel =
                gpsAge == null
                  ? 'GPS —'
                  : gpsAge <= 30
                    ? 'GPS live'
                    : gpsAge <= 300
                      ? `GPS ${gpsAge}s ago`
                      : 'GPS stale';
              return `<li class="device-card ${cap ? 'capsize' : ''}">
                <div class="device-card__id">${esc(d.deviceId)} ${cap ? '· CAPSIZE' : ''}</div>
                <div class="device-card__meta">${d.online ? 'Online' : 'Offline'} · ${gpsLabel} · ${spm} · seen ${d.lastSeenAgoSec ?? '—'}s ago</div>
              </li>`;
            })
            .join('')}</ul>
        </section>
        <section class="coach-panel" data-panel="history" ${tab === 'history' ? '' : 'hidden'}>
          <label class="coach-field">Device
            <input type="text" id="historyDevice" placeholder="Device ID" />
          </label>
          <button type="button" class="coach-btn coach-btn--ghost" data-load-sessions>Load sessions</button>
          <label class="coach-field">Session
            <select id="historySession"><option value="">— load sessions first —</option></select>
          </label>
          <button type="button" class="coach-btn coach-btn--primary" data-load-track>Load trace & charts</button>
          <div id="historyMap" class="history-map"></div>
          <canvas id="chartSpeedTime" class="history-chart" height="160"></canvas>
          <canvas id="chartSpeedDist" class="history-chart" height="160"></canvas>
        </section>
        <section class="coach-panel" data-panel="settings" ${tab === 'settings' ? '' : 'hidden'}>
          <label class="coach-field">API base URL
            <input type="url" id="apiBase" value="${esc(settings.apiBaseUrl)}" placeholder="https://your-app.vercel.app" />
          </label>
          <label class="coach-field">Ingest token (Bearer)
            <input type="password" id="ingestToken" value="${esc(settings.ingestToken)}" autocomplete="off" />
          </label>
          <button type="button" class="coach-btn coach-btn--primary" data-save-settings>Save settings</button>
          <p class="poll-line">Same URL and token as the rower app / dashboard. Monitoring must be stopped to change URL safely.</p>
        </section>
      </div>`;

    root.querySelector('[data-start-monitor]')?.addEventListener('click', () => void onStartMonitoring());
    root.querySelector('[data-stop-monitor]')?.addEventListener('click', () => void onStopMonitoring());
    root.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        tab = (btn as HTMLElement).dataset.tab as Tab;
        render();
        if (tab === 'live') {
          ensureMap();
          updateMap();
        }
      });
    });
    root.querySelector('[data-save-settings]')?.addEventListener('click', () => {
      settings = {
        apiBaseUrl: (root.querySelector('#apiBase') as HTMLInputElement).value.trim(),
        ingestToken: (root.querySelector('#ingestToken') as HTMLInputElement).value.trim(),
      };
      saveSettings(settings);
      setStatus('Settings saved');
    });
    root.querySelector('[data-load-sessions]')?.addEventListener('click', () => {
      void (async () => {
        settings = loadSettings();
        const deviceId = (root.querySelector('#historyDevice') as HTMLInputElement).value.trim();
        if (!deviceId) return;
        sessions = await listSessions(settings, deviceId);
        const sel = root.querySelector('#historySession') as HTMLSelectElement;
        sel.innerHTML = sessions
          .map(
            (s) =>
              `<option value="${esc(s.session_id)}">${esc(s.started_at)} (${esc(String(s.session_id).slice(0, 8))}…)</option>`,
          )
          .join('');
      })().catch((e) => setStatus(String(e), true));
    });
    root.querySelector('[data-load-track]')?.addEventListener('click', () => {
      void (async () => {
        settings = loadSettings();
        const sessionId = (root.querySelector('#historySession') as HTMLSelectElement).value;
        if (!sessionId) return;
        await loadHistorySession(sessionId);
      })().catch((e) => setStatus(String(e), true));
    });

    if (tab === 'live') {
      ensureMap();
      updateMap();
    }
  }

  void (async () => {
    await refreshMonitoringStatus();
    if (monitoring) startPollTimer();
    render();
    void pollLive();
  })();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && monitoring) void pollLive();
  });
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}
