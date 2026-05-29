/**
 * Live monitor charts — stats over time + database storage bar.
 * Loaded after dashboard-history.js (reuses drawLineChart pattern).
 */
(function () {
  const MAX_POINTS = 450;
  const STORAGE_REFRESH_MS = 30_000;

  /** @type {{ t: number, online: number, devices: number, ingestHz: number, gpsAgeSec: number, delayedGps: number, capsize: number }[]} */
  const history = [];

  let lastStorageFetch = 0;
  /** @type {object | null} */
  let lastStorageStats = null;

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

  function drawLineChart(canvas, series, opts) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 600;
    const h = canvas.clientHeight || 120;
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
      ctx.fillText(opts.empty || 'Collecting data…', pad.l, h / 2);
      return;
    }

    const t0 = valid[0].t;
    const t1 = valid[valid.length - 1].t;
    const yMin = opts.yMin != null ? opts.yMin : Math.min(...valid.map((p) => p.y));
    const yMax = opts.yMax != null ? opts.yMax : Math.max(...valid.map((p) => p.y));
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
    ctx.fillText(`${opts.formatY?.(yMin) ?? yMin.toFixed(1)}`, 4, pad.t + plotH);
    ctx.fillText(`${opts.formatY?.(yMax) ?? yMax.toFixed(1)}`, 4, pad.t + 12);
    ctx.fillText(new Date(t0).toLocaleTimeString(), pad.l, h - 6);
    ctx.fillText(new Date(t1).toLocaleTimeString(), pad.l + plotW - 56, h - 6);
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(opts.title || '', pad.l, 14);
  }

  function fmtBytes(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function drawStorageBarChart(canvas, stats) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 600;
    const h = canvas.clientHeight || 200;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const caption = $('#monitorStorageCaption');
    if (!stats?.usedBytes) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText('Storage stats unavailable — check ingest token', 16, h / 2);
      if (caption) caption.textContent = '';
      return;
    }

    const used = Number(stats.usedBytes);
    const limit =
      stats.storageLimitBytes != null && stats.storageLimitBytes > 0
        ? Number(stats.storageLimitBytes)
        : null;
    const available = limit != null ? Math.max(0, limit - used) : null;

    const labels =
      limit != null
        ? [
            { key: 'used', label: 'Used', value: used, color: '#22d3ee' },
            { key: 'avail', label: 'Available', value: available, color: '#334155' },
            { key: 'total', label: 'Total quota', value: limit, color: '#64748b' },
          ]
        : [{ key: 'used', label: 'Used', value: used, color: '#22d3ee' }];

    const maxVal = Math.max(...labels.map((b) => b.value), 1);
    const pad = { l: 16, r: 16, t: 28, b: 36 };
    const chartW = w - pad.l - pad.r;
    const chartH = h - pad.t - pad.b;
    const barGap = 24;
    const barW = Math.min(
      120,
      (chartW - barGap * (labels.length - 1)) / labels.length,
    );
    const groupW = labels.length * barW + (labels.length - 1) * barGap;
    let x0 = pad.l + (chartW - groupW) / 2;

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillText('Database storage', pad.l, 18);

    labels.forEach((bar) => {
      const barH = (bar.value / maxVal) * chartH;
      const x = x0;
      const y = pad.t + chartH - barH;

      ctx.fillStyle = bar.color;
      ctx.fillRect(x, y, barW, barH);

      ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
      ctx.strokeRect(x, pad.t, barW, chartH);

      ctx.fillStyle = '#e2e8f0';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(bar.label, x + barW / 2, h - 18);
      ctx.fillText(fmtBytes(bar.value), x + barW / 2, h - 4);
      ctx.textAlign = 'left';

      x0 += barW + barGap;
    });

    if (caption) {
      const pct =
        stats.storageUsedPct != null
          ? `${Number(stats.storageUsedPct).toFixed(1)}% of quota`
          : '';
      caption.textContent =
        limit != null
          ? `${fmtBytes(used)} used · ${fmtBytes(available)} available · ${fmtBytes(limit)} total ${pct ? `(${pct})` : ''}`
          : `${fmtBytes(used)} used · set POSTGRES_STORAGE_LIMIT_MB on Vercel to show available & total`;
    }
  }

  function renderStatsCharts() {
    const pts = downsample(history, MAX_POINTS);
    if (!pts.length) return;

    drawLineChart(
      $('#monitorChartOnline'),
      pts.map((p) => ({ t: p.t, y: p.online })),
      {
        title: 'Online devices',
        yLabel: 'count',
        color: '#4ade80',
        formatY: (v) => String(Math.round(v)),
        yMin: 0,
      },
    );

    drawLineChart(
      $('#monitorChartIngest'),
      pts.map((p) => ({ t: p.t, y: p.ingestHz })),
      {
        title: 'Avg ingest rate',
        yLabel: 'Hz',
        color: '#22d3ee',
        formatY: (v) => v.toFixed(2),
        yMin: 0,
      },
    );

    drawLineChart(
      $('#monitorChartGpsAge'),
      pts.map((p) => ({ t: p.t, y: p.gpsAgeSec })),
      {
        title: 'Avg GPS fix age',
        yLabel: 'sec',
        color: '#fbbf24',
        formatY: (v) => v.toFixed(1),
        yMin: 0,
      },
    );

    const hint = $('#monitorStatsHint');
    if (hint && pts.length >= 2) {
      const spanMin = Math.round((pts[pts.length - 1].t - pts[0].t) / 60000);
      hint.textContent = `Last ${spanMin} min · ${pts.length} samples · updates each poll`;
    }
  }

  function recordPollSnapshot(data) {
    const health = data.health || {};
    const now = data.polledAt || Date.now();
    history.push({
      t: now,
      online: health.onlineDevices ?? data.activeCount ?? 0,
      devices: data.deviceCount ?? 0,
      ingestHz: health.avgIngestHz ?? 0,
      gpsAgeSec: health.avgGpsAgeSec ?? 0,
      delayedGps: health.delayedGpsDevices ?? 0,
      capsize: health.capsizeDevices ?? 0,
    });
    while (history.length > MAX_POINTS) history.shift();
    renderStatsCharts();
  }

  async function refreshStorageChart(force = false) {
    const now = Date.now();
    if (!force && now - lastStorageFetch < STORAGE_REFRESH_MS) {
      drawStorageBarChart($('#monitorChartStorage'), lastStorageStats);
      return;
    }
    lastStorageFetch = now;
    const apiBase = window.dashboardApiBase?.() || window.location.origin;
    const headers = window.dashboardHeaders?.() || { Accept: 'application/json' };
    try {
      const res = await fetch(`${apiBase}/api/history?storage=stats`, { headers });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      lastStorageStats = data.stats || null;
    } catch {
      lastStorageStats = null;
    }
    drawStorageBarChart($('#monitorChartStorage'), lastStorageStats);
  }

  function onPoll(data) {
    recordPollSnapshot(data);
    void refreshStorageChart(false);
  }

  function init() {
    window.addEventListener('resize', () => {
      renderStatsCharts();
      drawStorageBarChart($('#monitorChartStorage'), lastStorageStats);
    });
    void refreshStorageChart(true);
  }

  window.dashboardMonitorCharts = {
    onPoll,
    refreshStorage: () => refreshStorageChart(true),
    init,
  };

  init();
})();
