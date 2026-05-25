/**
 * Session history — map trace, HR/speed charts, capsize incidents.
 * Expects dashboard.js globals: apiBase(), headers(), $()
 */
(function () {
  const LS_HISTORY_DEVICE = 'rnz_history_device';

  let historyMap = null;
  let historyLayer = null;
  let historyMarkers = null;

  function toLocalInputValue(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fromLocalInputValue(v) {
    const ms = new Date(v).getTime();
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }

  function fmtTime(ms) {
    return new Date(ms).toLocaleString();
  }

  function fmtSpeedMps(mps) {
    if (mps == null || mps < 0) return '—';
    return `${mps.toFixed(2)} m/s`;
  }

  function fmtPace(mps) {
    if (mps == null || mps <= 0.1) return '—';
    const secPer500 = 500 / mps;
    const m = Math.floor(secPer500 / 60);
    const s = Math.round(secPer500 % 60);
    return `${m}:${String(s).padStart(2, '0')} /500m`;
  }

  function downsample(points, maxPoints) {
    if (points.length <= maxPoints) return points;
    const step = Math.ceil(points.length / maxPoints);
    const out = [];
    for (let i = 0; i < points.length; i += step) out.push(points[i]);
    if (out[out.length - 1] !== points[points.length - 1]) {
      out.push(points[points.length - 1]);
    }
    return out;
  }

  function drawLineChart(canvas, series, opts) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 600;
    const h = canvas.clientHeight || 160;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const pad = { l: 44, r: 12, t: 22, b: 28 };
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;

    const valid = series.filter((p) => p.y != null && Number.isFinite(p.y));
    if (valid.length < 2) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText(opts.empty || 'No data', pad.l, h / 2);
      return;
    }

    const t0 = valid[0].t;
    const t1 = valid[valid.length - 1].t;
    const yMin = Math.min(...valid.map((p) => p.y));
    const yMax = Math.max(...valid.map((p) => p.y));
    const ySpan = yMax - yMin || 1;

    const xAt = (t) => pad.l + ((t - t0) / (t1 - t0 || 1)) * plotW;
    const yAt = (y) => pad.t + plotH - ((y - yMin) / ySpan) * plotH;

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + (plotH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + plotW, y);
      ctx.stroke();
    }

    ctx.strokeStyle = opts.color || '#22d3ee';
    ctx.lineWidth = 2;
    ctx.beginPath();
    valid.forEach((p, i) => {
      const x = xAt(p.t);
      const y = yAt(p.y);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(opts.yLabel || '', 4, pad.t + 10);
    ctx.fillText(
      `${opts.formatY?.(yMin) ?? yMin.toFixed(1)}`,
      4,
      pad.t + plotH,
    );
    ctx.fillText(
      `${opts.formatY?.(yMax) ?? yMax.toFixed(1)}`,
      4,
      pad.t + 12,
    );
    ctx.fillText(new Date(t0).toLocaleTimeString(), pad.l, h - 6);
    ctx.fillText(new Date(t1).toLocaleTimeString(), pad.l + plotW - 56, h - 6);
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(opts.title || '', pad.l, 14);
  }

  function initHistoryMap() {
    const el = document.getElementById('historyMap');
    if (!el || historyMap || typeof L === 'undefined') return;
    historyMap = L.map(el, { zoomControl: true }).setView([-37.9305, 175.5485], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(historyMap);
    historyLayer = L.layerGroup().addTo(historyMap);
    historyMarkers = L.layerGroup().addTo(historyMap);
  }

  function renderHistoryMap(track, capsizeEvents) {
    initHistoryMap();
    if (!historyMap || !historyLayer) return;
    historyLayer.clearLayers();
    historyMarkers.clearLayers();

    const latlngs = track
      .filter((p) => p.lat != null && p.lon != null)
      .map((p) => [p.lat, p.lon]);

    if (latlngs.length >= 2) {
      const line = L.polyline(latlngs, {
        color: '#22d3ee',
        weight: 4,
        opacity: 0.85,
      });
      historyLayer.addLayer(line);
      historyMap.fitBounds(line.getBounds(), { padding: [32, 32], maxZoom: 16 });
    } else if (latlngs.length === 1) {
      historyMap.setView(latlngs[0], 15);
    }

    if (latlngs.length) {
      const start = L.circleMarker(latlngs[0], {
        radius: 7,
        color: '#22c55e',
        fillColor: '#22c55e',
        fillOpacity: 0.9,
        weight: 2,
      }).bindPopup('Start');
      const end = L.circleMarker(latlngs[latlngs.length - 1], {
        radius: 7,
        color: '#3b82f6',
        fillColor: '#3b82f6',
        fillOpacity: 0.9,
        weight: 2,
      }).bindPopup('End');
      historyLayer.addLayer(start);
      historyLayer.addLayer(end);
    }

    for (const ev of capsizeEvents) {
      const m = L.circleMarker([ev.lat, ev.lon], {
        radius: 12,
        color: '#ef4444',
        fillColor: '#f97316',
        fillOpacity: 0.95,
        weight: 3,
      }).bindPopup(
        `<strong>Capsize</strong><br>${fmtTime(ev.t)}${ev.tiltDeg != null ? `<br>Tilt ${ev.tiltDeg}°` : ''}`,
      );
      historyMarkers.addLayer(m);
    }

    setTimeout(() => historyMap?.invalidateSize(), 80);
  }

  function renderCharts(track) {
    const hrCanvas = document.getElementById('historyChartHr');
    const speedCanvas = document.getElementById('historyChartSpeed');
    const strokeCanvas = document.getElementById('historyChartStroke');

    const hrSeries = downsample(
      track.filter((p) => p.hr != null).map((p) => ({ t: p.t, y: p.hr })),
      1200,
    );
    const speedSeries = downsample(
      track.filter((p) => p.speed != null && p.speed >= 0).map((p) => ({ t: p.t, y: p.speed })),
      1200,
    );
    const strokeSeries = downsample(
      track.filter((p) => p.strokeRate != null && p.strokeRate > 0).map((p) => ({ t: p.t, y: p.strokeRate })),
      1200,
    );

    drawLineChart(hrCanvas, hrSeries, {
      title: 'Heart rate (bpm)',
      color: '#f472b6',
      yLabel: 'bpm',
      formatY: (v) => `${Math.round(v)}`,
      empty: 'No heart rate in this range',
    });
    drawLineChart(speedCanvas, speedSeries, {
      title: 'GPS speed (m/s)',
      color: '#38bdf8',
      yLabel: 'm/s',
      formatY: (v) => v.toFixed(1),
      empty: 'No GPS speed in this range',
    });
    drawLineChart(strokeCanvas, strokeSeries, {
      title: 'Stroke rate (spm)',
      color: '#a78bfa',
      yLabel: 'spm',
      formatY: (v) => `${Math.round(v)}`,
      empty: 'No stroke rate in this range',
    });

    const strokeWrap = document.getElementById('historyChartStrokeWrap');
    if (strokeWrap) strokeWrap.hidden = strokeSeries.length < 2;
  }

  function renderCapsizeList(events, sampleCount) {
    const el = document.getElementById('historyCapsizeList');
    if (!el) return;
    if (!events.length) {
      el.innerHTML =
        sampleCount > 0
          ? '<p class="history-capsize-empty">Capsize samples in data but no GPS at event time.</p>'
          : '<p class="history-capsize-empty">No capsize events in this range.</p>';
      return;
    }
    el.innerHTML = `
      <h3 class="history-subtitle">Capsize incidents (${events.length})</h3>
      <ul class="history-capsize-ul">
        ${events
          .map(
            (ev) => `
          <li>
            <strong>${fmtTime(ev.t)}</strong>
            · ${ev.lat.toFixed(5)}, ${ev.lon.toFixed(5)}
            ${ev.tiltDeg != null ? ` · ${ev.tiltDeg}° tilt` : ''}
          </li>`,
          )
          .join('')}
      </ul>
      ${sampleCount > events.length ? `<p class="history-capsize-note">${sampleCount} capsize samples collapsed into ${events.length} incident(s).</p>` : ''}
    `;
  }

  function setHistoryStatus(msg, isErr) {
    const el = document.getElementById('historyStatus');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('err', Boolean(isErr));
  }

  async function fetchJson(url) {
    const res = await fetch(url, { headers: window.dashboardHeaders?.() || {} });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status} ${text.slice(0, 120)}`);
    }
    return res.json();
  }

  function mergeDeviceIds(ids) {
    const sel = document.getElementById('historyDeviceId');
    if (!sel || !ids?.length) return;
    const seen = new Set([...sel.options].map((o) => o.value).filter(Boolean));
    for (const id of ids) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id;
      sel.appendChild(opt);
    }
  }

  async function loadDeviceOptions() {
    const sel = document.getElementById('historyDeviceId');
    if (!sel) return;
    const seen = new Set();
    const opts = [];

    try {
      const data = await fetchJson(`${window.dashboardApiBase()}/api/history?list=devices`);
      for (const d of data.devices || []) {
        if (!d.uniqueId || seen.has(d.uniqueId)) continue;
        seen.add(d.uniqueId);
        opts.push({ id: d.uniqueId, label: d.uniqueId });
      }
    } catch {
      /* optional */
    }

    const saved = localStorage.getItem(LS_HISTORY_DEVICE) || '';
    sel.innerHTML =
      '<option value="">— select device —</option>' +
      opts.map((o) => `<option value="${o.id}">${o.label}</option>`).join('');
    if (saved && seen.has(saved)) sel.value = saved;
  }

  window.mergeHistoryDevices = mergeDeviceIds;

  async function loadSessionOptions() {
    const deviceId = document.getElementById('historyDeviceId')?.value?.trim();
    const sel = document.getElementById('historySessionId');
    if (!sel) return;
    sel.innerHTML = '<option value="">— or pick a session —</option>';
    if (!deviceId) return;

    try {
      const url = `${window.dashboardApiBase()}/api/history?list=sessions&uniqueId=${encodeURIComponent(deviceId)}`;
      const data = await fetchJson(url);
      for (const s of data.sessions || []) {
        const start = new Date(s.started_at).toLocaleString();
        const end = s.ended_at ? new Date(s.ended_at).toLocaleString() : 'ongoing';
        const label = `${start} → ${end} (${s.sample_count ?? 0} pts)`;
        const opt = document.createElement('option');
        opt.value = s.session_id;
        opt.textContent = label;
        sel.appendChild(opt);
      }
    } catch (e) {
      setHistoryStatus(`Sessions: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  async function loadHistory() {
    const deviceId = document.getElementById('historyDeviceId')?.value?.trim();
    const sessionId = document.getElementById('historySessionId')?.value?.trim();
    const fromLocal = document.getElementById('historyFrom')?.value;
    const toLocal = document.getElementById('historyTo')?.value;

    let url;
    if (sessionId) {
      url = `${window.dashboardApiBase()}/api/history?format=dashboard&sessionId=${encodeURIComponent(sessionId)}`;
    } else {
      if (!deviceId) {
        setHistoryStatus('Select a device ID or session.', true);
        return;
      }
      const from = fromLocalInputValue(fromLocal);
      const to = fromLocalInputValue(toLocal);
      if (!from || !to) {
        setHistoryStatus('Set from and to dates.', true);
        return;
      }
      url = `${window.dashboardApiBase()}/api/history?format=dashboard&uniqueId=${encodeURIComponent(deviceId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      localStorage.setItem(LS_HISTORY_DEVICE, deviceId);
    }

    setHistoryStatus('Loading history…');
    const results = document.getElementById('historyResults');
    if (results) results.hidden = true;

    try {
      const data = await fetchJson(url);
      if (!data.track?.length) {
        setHistoryStatus('No samples found for this query.', true);
        return;
      }

      const maxSpd = Math.max(
        0,
        ...data.track.map((p) => (p.speed != null ? p.speed : 0)),
      );
      const hrPts = data.track.filter((p) => p.hr != null).length;
      setHistoryStatus(
        `${data.pointCount} samples · ${data.gpsCount} GPS · ${hrPts} HR · max ${fmtSpeedMps(maxSpd)} (${fmtPace(maxSpd)}) · ${data.capsizeEvents?.length ?? 0} capsize incident(s)`,
      );

      renderHistoryMap(data.track, data.capsizeEvents || []);
      renderCharts(data.track);
      renderCapsizeList(data.capsizeEvents || [], data.capsizeSampleCount || 0);

      const meta = document.getElementById('historyMeta');
      if (meta) {
        meta.textContent = `${data.uniqueId || deviceId}${data.sessionId ? ` · session ${data.sessionId.slice(0, 8)}…` : ''} · ${fmtTime(new Date(data.from).getTime())} – ${fmtTime(new Date(data.to).getTime())}`;
      }
      if (results) results.hidden = false;
    } catch (e) {
      setHistoryStatus(`History error: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  window.initDashboardHistory = function initDashboardHistory() {
    const now = Date.now();
    const fromEl = document.getElementById('historyFrom');
    const toEl = document.getElementById('historyTo');
    if (fromEl && !fromEl.value) fromEl.value = toLocalInputValue(now - 24 * 60 * 60 * 1000);
    if (toEl && !toEl.value) toEl.value = toLocalInputValue(now);

    initHistoryMap();
    void loadDeviceOptions();

    document.getElementById('historyDeviceId')?.addEventListener('change', () => {
      void loadSessionOptions();
    });
    document.getElementById('historyLoadBtn')?.addEventListener('click', () => void loadHistory());
    document.getElementById('historySessionId')?.addEventListener('change', () => {
      const sid = document.getElementById('historySessionId')?.value;
      if (sid) void loadHistory();
    });
  };
})();
