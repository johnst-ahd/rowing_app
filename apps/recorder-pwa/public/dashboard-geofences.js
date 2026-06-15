/**
 * Dashboard geofence zone management (Leaflet circles + /api/geofences).
 */
(function () {
  const $ = (sel) => document.querySelector(sel);

  let geofenceLayer = null;
  let pickMode = false;
  let geofences = [];

  function headers() {
    if (typeof window.dashboardHeaders === 'function') return window.dashboardHeaders();
    return { Accept: 'application/json', 'Content-Type': 'application/json' };
  }

  function apiBase() {
    if (typeof window.dashboardApiBase === 'function') return window.dashboardApiBase();
    return window.location.origin;
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
  }

  function setStatus(msg, isError) {
    const el = $('#geofenceStatus');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('poll-line--warn', !!isError);
  }

  function getMap() {
    return window.dashboardFleetMap || null;
  }

  function drawGeofences() {
    const map = getMap();
    if (!map || typeof L === 'undefined') return;
    if (!geofenceLayer) {
      geofenceLayer = L.layerGroup().addTo(map);
    }
    geofenceLayer.clearLayers();
    for (const g of geofences) {
      if (!g.enabled) continue;
      const circle = L.circle([g.centerLat, g.centerLon], {
        radius: g.radiusM,
        color: '#f59e0b',
        fillColor: '#f59e0b',
        fillOpacity: 0.12,
        weight: 2,
        dashArray: '6 4',
      });
      circle.bindPopup(
        `<strong>${esc(g.name)}</strong><br>Geofence zone · ${Math.round(g.radiusM)} m radius<br>GPS every ${g.economyGpsIntervalSec}s · capsize ${g.disableCapsize ? 'off' : 'on'}`,
      );
      geofenceLayer.addLayer(circle);
    }
  }

  async function loadGeofences() {
    const res = await fetch(`${apiBase()}/api/geofences`, { headers: headers() });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    if (!data.persisted) {
      setStatus('Postgres required — set POSTGRES_URL on Vercel to store geofences.', true);
    }
    geofences = data.geofences || [];
    renderList();
    drawGeofences();
    if (data.persisted) setStatus(`${geofences.length} geofence(s) loaded.`);
  }

  function renderList() {
    const el = $('#geofenceList');
    if (!el) return;
    if (!geofences.length) {
      el.innerHTML = '<p class="poll-line">No geofence zones yet. Add one below or pick a centre on the fleet map.</p>';
      return;
    }
    el.innerHTML = geofences
      .map(
        (g) => `
      <div class="geofence-item" data-id="${g.id}">
        <div class="geofence-item__main">
          <strong>${esc(g.name)}</strong>
          <span class="geofence-item__meta">${g.centerLat.toFixed(5)}, ${g.centerLon.toFixed(5)} · ${Math.round(g.radiusM)} m</span>
          <span class="geofence-item__meta">Economy: GPS ${g.economyGpsIntervalSec}s · upload ${g.economyUploadIntervalSec}s · capsize ${g.disableCapsize ? 'off' : 'on'}</span>
        </div>
        <button type="button" class="hub-btn hub-btn--danger geofence-delete-btn" data-id="${g.id}">Delete</button>
      </div>`,
      )
      .join('');
    el.querySelectorAll('.geofence-delete-btn').forEach((btn) => {
      btn.addEventListener('click', () => void deleteGeofence(btn.getAttribute('data-id')));
    });
  }

  async function deleteGeofence(id) {
    if (!id || !confirm('Delete this geofence zone?')) return;
    setStatus('Deleting…');
    const res = await fetch(`${apiBase()}/api/geofences?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: headers(),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setStatus(data.error || 'Delete failed', true);
      return;
    }
    await loadGeofences();
  }

  async function createGeofence(ev) {
    ev.preventDefault();
    const name = $('#geofenceName')?.value?.trim();
    const centerLat = Number($('#geofenceLat')?.value);
    const centerLon = Number($('#geofenceLon')?.value);
    const radiusM = Number($('#geofenceRadius')?.value);
    const economyGpsIntervalSec = Number($('#geofenceGpsSec')?.value) || 30;
    const economyUploadIntervalSec = Number($('#geofenceUploadSec')?.value) || 30;
    const disableCapsize = $('#geofenceDisableCapsize')?.checked !== false;

    if (!name) {
      setStatus('Name is required.', true);
      return;
    }
    if (!Number.isFinite(centerLat) || !Number.isFinite(centerLon)) {
      setStatus('Latitude and longitude are required.', true);
      return;
    }
    if (!Number.isFinite(radiusM) || radiusM <= 0) {
      setStatus('Radius must be a positive number (metres).', true);
      return;
    }

    setStatus('Saving…');
    const res = await fetch(`${apiBase()}/api/geofences`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        name,
        kind: 'boat_park',
        centerLat,
        centerLon,
        radiusM,
        economyGpsIntervalSec,
        economyUploadIntervalSec,
        disableCapsize,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setStatus(data.error || 'Save failed', true);
      return;
    }
    $('#geofenceForm')?.reset();
    if ($('#geofenceGpsSec')) $('#geofenceGpsSec').value = '30';
    if ($('#geofenceUploadSec')) $('#geofenceUploadSec').value = '30';
    if ($('#geofenceDisableCapsize')) $('#geofenceDisableCapsize').checked = true;
    await loadGeofences();
  }

  function setPickMode(on) {
    pickMode = on;
    const btn = $('#geofencePickBtn');
    if (btn) {
      btn.textContent = on ? 'Click map to set centre…' : 'Pick centre on map';
      btn.classList.toggle('hub-btn--primary', on);
    }
    const map = getMap();
    if (map) map.getContainer().style.cursor = on ? 'crosshair' : '';
  }

  function onMapClick(e) {
    if (!pickMode) return;
    const lat = e.latlng.lat;
    const lon = e.latlng.lng;
    const latEl = $('#geofenceLat');
    const lonEl = $('#geofenceLon');
    if (latEl) latEl.value = lat.toFixed(6);
    if (lonEl) lonEl.value = lon.toFixed(6);
    setPickMode(false);
    setStatus(`Centre set to ${lat.toFixed(5)}, ${lon.toFixed(5)}`);
  }

  function useMapCentre() {
    const map = getMap();
    if (!map) return;
    const c = map.getCenter();
    const latEl = $('#geofenceLat');
    const lonEl = $('#geofenceLon');
    if (latEl) latEl.value = c.lat.toFixed(6);
    if (lonEl) lonEl.value = c.lng.toFixed(6);
    setStatus(`Centre set to map view ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`);
  }

  function bind() {
    $('#geofenceForm')?.addEventListener('submit', createGeofence);
    $('#geofencePickBtn')?.addEventListener('click', () => setPickMode(!pickMode));
    $('#geofenceMapCentreBtn')?.addEventListener('click', useMapCentre);
    $('#geofenceRefreshBtn')?.addEventListener('click', () => void loadGeofences().catch((e) => setStatus(String(e.message || e), true)));

    const map = getMap();
    if (map) map.on('click', onMapClick);
  }

  window.dashboardInitGeofences = function () {
    bind();
    void loadGeofences().catch((e) => setStatus(String(e.message || e), true));
  };

  window.dashboardRefreshGeofences = function () {
    void loadGeofences().catch(() => {});
  };
})();
