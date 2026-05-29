/**
 * Live monitor — combined stats chart (updates each poll).
 */
(function () {
  const MAX_POINTS = 450;

  /** @type {{ t: number, online: number, ingestHz: number, gpsHz: number, gpsAgeSec: number, serverLagSec: number, delayedGps: number, capsize: number, strokeSpm: number, heartbeatHz: number, batteryPct: number }[]} */
  const history = [];

  const SERIES = [
    {
      key: 'online',
      label: 'Online devices',
      color: '#4ade80',
      pick: (p) => p.online,
      format: (v) => String(Math.round(v)),
    },
    {
      key: 'gpsHz',
      label: 'GPS (Hz)',
      color: '#38bdf8',
      pick: (p) => p.gpsHz,
      format: (v) => v.toFixed(2),
    },
    {
      key: 'ingestHz',
      label: 'Ingest (Hz)',
      color: '#22d3ee',
      pick: (p) => p.ingestHz,
      format: (v) => v.toFixed(2),
    },
    {
      key: 'heartbeatHz',
      label: 'Heartbeat (Hz)',
      color: '#86efac',
      pick: (p) => p.heartbeatHz,
      format: (v) => v.toFixed(2),
      hideWhenZero: true,
    },
    {
      key: 'batteryPct',
      label: 'Battery (%)',
      color: '#fcd34d',
      pick: (p) => p.batteryPct,
      format: (v) => (v > 0 ? String(Math.round(v)) : '—'),
      hideWhenZero: true,
    },
    {
      key: 'gpsAgeSec',
      label: 'GPS age (s)',
      color: '#fbbf24',
      pick: (p) => p.gpsAgeSec,
      format: (v) => v.toFixed(1),
    },
    {
      key: 'serverLagSec',
      label: 'Upload lag (s)',
      color: '#f97316',
      pick: (p) => p.serverLagSec,
      format: (v) => v.toFixed(0),
    },
    {
      key: 'delayedGps',
      label: 'Delayed GPS',
      color: '#fb7185',
      pick: (p) => p.delayedGps,
      format: (v) => String(Math.round(v)),
    },
    {
      key: 'strokeSpm',
      label: 'Stroke (spm)',
      color: '#a78bfa',
      pick: (p) => p.strokeSpm,
      format: (v) => (v > 0 ? String(Math.round(v)) : '—'),
      hideWhenZero: true,
    },
    {
      key: 'capsize',
      label: 'Capsize alerts',
      color: '#ef4444',
      pick: (p) => p.capsize,
      format: (v) => String(Math.round(v)),
      hideWhenZero: true,
    },
  ];

  function $(sel) {
    return document.querySelector(sel);
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

  function seriesRange(pts, pick) {
    const vals = pts.map(pick).filter((v) => Number.isFinite(v));
    if (!vals.length) return { min: 0, max: 1 };
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    return { min, max: max === min ? min + 1 : max };
  }

  function visibleSeries(pts) {
    const latest = pts[pts.length - 1];
    return SERIES.filter((s) => {
      if (!s.hideWhenZero || !latest) return true;
      const v = s.pick(latest);
      if (pts.length < 2) return v > 0;
      return pts.some((p) => s.pick(p) > 0);
    });
  }

  function drawCombinedChart(canvas, pts) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 600;
    const h = canvas.clientHeight || 110;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const pad = { l: 12, r: 12, t: 28, b: 22 };
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;

    if (pts.length < 2) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText('Collecting data…', pad.l, h / 2);
      return;
    }

    const active = visibleSeries(pts);
    const t0 = pts[0].t;
    const t1 = pts[pts.length - 1].t;
    const xAt = (t) => pad.l + ((t - t0) / (t1 - t0 || 1)) * plotW;
    const yAt = (norm) => pad.t + plotH - norm * plotH;

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.2)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + (plotH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + plotW, y);
      ctx.stroke();
    }

    const latest = pts[pts.length - 1];
    const legendEl = $('#monitorChartLegend');
    if (legendEl) {
      legendEl.innerHTML = active
        .map((s) => {
          const val = s.pick(latest);
          const range = seriesRange(pts, s.pick);
          return `<span class="monitor-legend-item"><span class="monitor-legend-swatch" style="background:${s.color}"></span>${s.label}: <strong>${s.format(val)}</strong> <span class="monitor-legend-range">(max ${s.format(range.max)})</span></span>`;
        })
        .join('');
    }

    for (const s of active) {
      const range = seriesRange(pts, s.pick);
      const span = range.max - range.min || 1;
      const linePts = pts
        .map((p) => {
          const y = s.pick(p);
          if (!Number.isFinite(y)) return null;
          return { t: p.t, norm: (y - range.min) / span };
        })
        .filter(Boolean);

      if (linePts.length < 2) continue;

      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      linePts.forEach((p, i) => {
        const x = xAt(p.t);
        const y = yAt(p.norm);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('0%', pad.l, pad.t + plotH + 2);
    ctx.fillText('100% (per metric)', pad.l, pad.t + 4);
    ctx.fillText(new Date(t0).toLocaleTimeString(), pad.l, h - 6);
    ctx.fillText(new Date(t1).toLocaleTimeString(), pad.l + plotW - 56, h - 6);
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText('Live stats (normalized)', pad.l, 16);
  }

  function renderStatsChart() {
    const pts = downsample(history, MAX_POINTS);
    drawCombinedChart($('#monitorChartCombined'), pts);

    const hint = $('#monitorStatsHint');
    if (hint && pts.length >= 2) {
      const spanMin = Math.round((pts[pts.length - 1].t - pts[0].t) / 60000);
      hint.textContent = `Last ${spanMin} min · ${pts.length} samples · lines scaled independently (see legend for values)`;
    }
  }

  function recordPollSnapshot(data) {
    const health = data.health || {};
    history.push({
      t: data.polledAt || Date.now(),
      online: health.onlineDevices ?? data.activeCount ?? 0,
      ingestHz: health.avgIngestHz ?? 0,
      gpsHz: health.avgGpsHz ?? 0,
      gpsAgeSec: health.avgGpsAgeSec ?? 0,
      serverLagSec: health.serverDataLagSec ?? 0,
      delayedGps: health.delayedGpsDevices ?? 0,
      capsize: health.capsizeDevices ?? 0,
      strokeSpm: health.avgStrokeSpm ?? 0,
      heartbeatHz: health.avgHeartbeatHz ?? 0,
      batteryPct: health.avgBatteryPct ?? 0,
    });
    while (history.length > MAX_POINTS) history.shift();
    renderStatsChart();
  }

  function onPoll(data) {
    recordPollSnapshot(data);
  }

  function init() {
    window.addEventListener('resize', renderStatsChart);
  }

  window.dashboardMonitorCharts = { onPoll, init };

  init();
})();
