import '../styles.css';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { HistoryPanel } from './history-panel';
import {
  fetchDevices,
  fetchMapPositions,
  type FleetDevice,
  type MapPosition,
} from '../lib/api';
import {
  getNativeMonitoringStatus,
  IS_NATIVE,
  startNativeMonitoring,
  stopNativeMonitoring,
} from '../lib/native-monitor';
import {
  clearMapTracks,
  displayLatLon,
  onMapDisplayTick,
  syncMapTracks,
} from '../lib/map-smooth';
import { loadSettings, saveSettings, DEFAULT_API_BASE_URL, type CoachSettings } from '../lib/settings';
import {
  gpsFixState,
  gpsStatusLabel,
  markerColorForState,
  resolveGpsDisplayAge,
  displayGpsAgeSec,
} from '../lib/gps-age';

type Tab = 'live' | 'history' | 'settings';

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
  let mapAutoFitDone = false;
  let mapTickUnsub: (() => void) | null = null;
  let historyPanel: HistoryPanel | null = null;

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
      syncMapTracks(pos);
      updateLivePanel();
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
        gpsAgeSec:
          d.gps?.displayAgeSec ??
          displayGpsAgeSec(d.gps?.ageSec, d.gps?.ingestAgoSec) ??
          p?.fixAgeSec ??
          d.gps?.ageSec ??
          undefined,
      });
    }
    for (const p of mapPositions) {
      if (!byId.has(p.deviceId)) {
        byId.set(p.deviceId, {
          deviceId: p.deviceId,
          online: true,
          lastSeenAgoSec: p.lastSeenAgoSec ?? p.fixAgeSec,
          gpsAgeSec: displayGpsAgeSec(p.fixAgeSec, p.lastSeenAgoSec) ?? p.fixAgeSec,
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
    const el = root.querySelector('#coachMap') as HTMLElement | null;
    if (!el) return;
    if (map && map.getContainer() !== el) {
      destroyMap();
      mapAutoFitDone = false;
    }
    if (map) return;
    try {
      map = L.map(el, { preferCanvas: true }).setView([-37.93, 175.55], 12);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap',
      }).addTo(map);
      markersLayer = L.layerGroup().addTo(map);
      setTimeout(() => map?.invalidateSize(), 150);
    } catch (e) {
      setStatus(
        `Map failed to load: ${e instanceof Error ? e.message : String(e)}`,
        true,
      );
    }
  }

  function markerIcon(p: MapPosition, device?: FleetDevice): L.DivIcon {
    const gpsAge = resolveGpsDisplayAge(device, p);
    const cap = Boolean(p.capsize);
    const state = gpsFixState(gpsAge);
    const color = markerColorForState(state, cap);
    const className = cap
      ? 'coach-marker capsize'
      : state === 'amber'
        ? 'coach-marker amber'
        : state === 'lost'
          ? 'coach-marker lost'
          : 'coach-marker';
    return L.divIcon({
      className,
      html: `<span style="background:${color};width:14px;height:14px;border-radius:50%;display:block;border:2px solid #fff"></span>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
  }

  function mapLatLngFor(p: MapPosition): L.LatLng {
    const display = displayLatLon(p.deviceId);
    if (display) return L.latLng(display.lat, display.lon);
    const lat = p.smoothLatitude ?? p.latitude;
    const lon = p.smoothLongitude ?? p.longitude;
    return L.latLng(lat, lon);
  }

  function updateMap() {
    ensureMap();
    if (!map || !markersLayer) return;
    const seen = new Set<string>();
    const latlngs: L.LatLng[] = [];
    const deviceById = new Map(devices.map((d) => [d.deviceId, d]));
    for (const p of positions) {
      if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue;
      seen.add(p.deviceId);
      const latlng = mapLatLngFor(p);
      latlngs.push(latlng);
      const icon = markerIcon(p, deviceById.get(p.deviceId));
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
    if (latlngs.length > 0 && !mapAutoFitDone) {
      map.fitBounds(L.latLngBounds(latlngs), { padding: [32, 32], maxZoom: 15 });
      mapAutoFitDone = true;
    }
    setTimeout(() => map?.invalidateSize(), 100);
  }

  function deviceCardHtml(d: FleetDevice): string {
    const cap = Boolean(d.rowing?.capsize);
    const spm =
      d.rowing?.strokeRateValid && d.rowing.strokeRate != null
        ? `${Math.round(d.rowing.strokeRate)} spm`
        : '—';
    const gpsAge = d.gpsAgeSec ?? resolveGpsDisplayAge(d);
    const gpsLabel = gpsAge == null ? 'GPS —' : gpsStatusLabel(gpsAge);
    return `<li class="device-card ${cap ? 'capsize' : ''}">
      <div class="device-card__id">${esc(d.deviceId)} ${cap ? '· CAPSIZE' : ''}</div>
      <div class="device-card__meta">${d.online ? 'Online' : 'Offline'} · ${gpsLabel} · ${spm} · seen ${d.lastSeenAgoSec ?? '—'}s ago</div>
    </li>`;
  }

  function updateLivePanel() {
    if (tab !== 'live') return;
    const caps = capsizeCount();
    const banner = root.querySelector('[data-capsize-banner]') as HTMLElement | null;
    if (banner) {
      banner.hidden = caps === 0;
      if (caps > 0) banner.textContent = `${caps} CAPSIZE — check crew now`;
    }
    const list = root.querySelector('[data-device-list]');
    if (list) list.innerHTML = devices.map(deviceCardHtml).join('');
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
    startMapTick();
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
    stopMapTick();
    clearMapTracks();
    render();
  }

  function startMapTick() {
    stopMapTick();
    mapTickUnsub = onMapDisplayTick((deviceId, lat, lon) => {
      const m = markers.get(deviceId);
      if (m) m.setLatLng([lat, lon]);
    });
  }

  function stopMapTick() {
    mapTickUnsub?.();
    mapTickUnsub = null;
  }

  function startPollTimer() {
    stopPollTimer();
    pollTimer = setInterval(() => void pollLive(), 2000);
  }

  function stopPollTimer() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function render() {
    if (tab === 'live') destroyMap();
    mapAutoFitDone = false;
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
        <div class="capsize-banner" data-capsize-banner role="alert" ${caps > 0 ? '' : 'hidden'}>${caps > 0 ? `${caps} CAPSIZE — check crew now` : ''}</div>
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
          <ul class="device-list" data-device-list>${devices.map(deviceCardHtml).join('')}</ul>
        </section>
        <section class="coach-panel coach-panel--history" data-panel="history" ${tab === 'history' ? '' : 'hidden'}>
          <div data-history-root></div>
        </section>
        <section class="coach-panel" data-panel="settings" ${tab === 'settings' ? '' : 'hidden'}>
          <label class="coach-field">API base URL
            <input type="url" id="apiBase" value="${esc(settings.apiBaseUrl)}" placeholder="${esc(DEFAULT_API_BASE_URL)}" />
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
        const next = (btn as HTMLElement).dataset.tab as Tab;
        if (tab === 'history' && next !== 'history') {
          historyPanel?.destroy();
          historyPanel = null;
        }
        if (tab === 'live' && next !== 'live') destroyMap();
        tab = next;
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

    if (tab === 'history') {
      const historyRoot = root.querySelector('[data-history-root]') as HTMLElement | null;
      if (historyRoot) {
        historyPanel = new HistoryPanel(
          historyRoot,
          () => loadSettings(),
          (msg, err) => setStatus(msg, err),
        );
        historyPanel.mount();
      }
    }

    if (tab === 'live') {
      ensureMap();
      updateMap();
    }
  }

  void (async () => {
    await refreshMonitoringStatus();
    if (monitoring) {
      startPollTimer();
      startMapTick();
    }
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
