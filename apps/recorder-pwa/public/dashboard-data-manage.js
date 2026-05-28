/**
 * Dashboard — stored data management (Vercel Postgres / Neon).
 */
(function () {
  const DELETE_ALL_CONFIRM = 'DELETE ALL RNZ DATA';
  const $ = (sel) => document.querySelector(sel);

  function apiBase() {
    return typeof window.dashboardApiBase === 'function'
      ? window.dashboardApiBase()
      : window.location.origin;
  }

  function headers() {
    return typeof window.dashboardHeaders === 'function'
      ? window.dashboardHeaders()
      : { Accept: 'application/json' };
  }

  function setStatus(msg, kind) {
    const el = $('#dataManageStatus');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('err', 'ok');
    if (kind) el.classList.add(kind);
  }

  function fmtDate(ms) {
    if (ms == null || !Number.isFinite(ms)) return '—';
    return new Date(ms).toLocaleString();
  }

  function fmtNum(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    return n.toLocaleString();
  }

  function fmtBytes(n) {
    if (n == null || !Number.isFinite(n) || n < 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function renderStats(stats, persisted) {
    const el = $('#dataManageStats');
    if (!el) return;
    if (!persisted) {
      el.innerHTML =
        '<p class="poll-line data-manage-security-warn">No database connected — add POSTGRES_URL on Vercel to persist uploads.</p>';
      return;
    }
    if (!stats) {
      el.innerHTML =
        '<p class="poll-line">Could not load storage summary (check ingest token).</p>';
      return;
    }
    const used = stats.usedBytes ?? null;
    const limit = stats.storageLimitBytes ?? null;
    const pct =
      stats.storageUsedPct != null
        ? Math.max(0, Math.min(100, Number(stats.storageUsedPct)))
        : null;
    const barFill = pct != null ? `${pct}%` : '0%';
    const barLabel =
      used != null && limit != null
        ? `${fmtBytes(used)} used of ${fmtBytes(limit)} (${pct?.toFixed?.(1) ?? pct}%)`
        : used != null
          ? `${fmtBytes(used)} used · set POSTGRES_STORAGE_LIMIT_MB to show available space`
          : 'Storage usage unavailable';
    el.innerHTML = `
      <div class="data-manage-stat">
        <span class="data-manage-stat__value">${fmtNum(stats.deviceCount)}</span>
        <span class="data-manage-stat__label">Devices</span>
      </div>
      <div class="data-manage-stat">
        <span class="data-manage-stat__value">${fmtNum(stats.sessionCount)}</span>
        <span class="data-manage-stat__label">Sessions</span>
      </div>
      <div class="data-manage-stat">
        <span class="data-manage-stat__value">${fmtNum(stats.sampleCount)}</span>
        <span class="data-manage-stat__label">Samples</span>
      </div>
      <div class="data-manage-stat">
        <span class="data-manage-stat__value" style="font-size:0.95rem">${fmtDate(stats.oldestSampleMs)}</span>
        <span class="data-manage-stat__label">Oldest sample</span>
      </div>
      <div class="data-manage-stat">
        <span class="data-manage-stat__value" style="font-size:0.95rem">${fmtDate(stats.newestSampleMs)}</span>
        <span class="data-manage-stat__label">Newest sample</span>
      </div>
      <div class="data-manage-storage-bar">
        <div class="data-manage-storage-bar__head">
          <span>Database storage</span>
          <span>${barLabel}</span>
        </div>
        <div class="data-manage-storage-bar__track" role="img" aria-label="${barLabel}">
          <span class="data-manage-storage-bar__fill" style="width:${barFill}"></span>
        </div>
      </div>
    `;
  }

  function renderSecurity(security) {
    const el = $('#dataManageSecurityBody');
    if (!el || !security) return;
    const warn = !security.tokenRequired
      ? `<p class="data-manage-security-warn">${security.accessControl}</p>`
      : `<p>${security.accessControl}</p>`;
    el.innerHTML = `
      ${warn}
      <ul>
        <li><strong>Provider:</strong> ${security.provider}</li>
        <li><strong>In transit:</strong> ${security.transport}</li>
        <li><strong>At rest:</strong> ${security.atRest}</li>
        <li><strong>Dashboard:</strong> ${security.dashboardAccess}</li>
        <li><strong>Retention:</strong> ${security.retention}</li>
        <li><strong>Deletes:</strong> ${security.irreversible}</li>
        <li><strong>Live monitor:</strong> ${security.liveCache}</li>
      </ul>
      ${
        security.recommendations?.length
          ? `<p><strong>Recommendations</strong></p><ul>${security.recommendations
              .map((r) => `<li>${r}</li>`)
              .join('')}</ul>`
          : ''
      }
    `;
  }

  function fillSelect(select, items, valueKey, labelFn) {
    if (!select) return;
    const current = select.value;
    select.innerHTML = `<option value="">— select —</option>`;
    for (const item of items) {
      const opt = document.createElement('option');
      opt.value = item[valueKey];
      opt.textContent = labelFn(item);
      select.appendChild(opt);
    }
    if (current && [...select.options].some((o) => o.value === current)) {
      select.value = current;
    }
  }

  async function loadLists() {
    const base = apiBase();
    const h = headers();
    const [devicesRes, sessionsRes] = await Promise.all([
      fetch(`${base}/api/history?list=devices`, { headers: h }),
      fetch(`${base}/api/history?list=sessions`, { headers: h }),
    ]);
    if (!devicesRes.ok || !sessionsRes.ok) {
      throw new Error('Could not load device/session lists (check ingest token).');
    }
    const devicesData = await devicesRes.json();
    const sessionsData = await sessionsRes.json();
    const devices = devicesData.devices || [];
    const sessions = sessionsData.sessions || [];

    fillSelect($('#dataDeleteDeviceId'), devices, 'uniqueId', (d) =>
      `${d.uniqueId} (${fmtNum(d.sampleCount)} samples)`,
    );
    fillSelect($('#dataDeleteRangeDeviceId'), devices, 'uniqueId', (d) => d.uniqueId);
    fillSelect($('#dataDeleteSessionId'), sessions, 'session_id', (s) => {
      const started = s.started_at ? new Date(s.started_at).toLocaleString() : '—';
      return `${s.unique_id} · ${started} · ${fmtNum(s.sample_count)} samples`;
    });
  }

  async function refreshSummary() {
    setStatus('Loading storage summary…');
    try {
      const res = await fetch(`${apiBase()}/api/history?storage=stats`, { headers: headers() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      renderStats(data.stats, data.persisted);
      renderSecurity(data.security);
      if (data.persisted) {
        await loadLists();
        setStatus('Storage summary updated.', 'ok');
      } else {
        setStatus('Database not configured on Vercel.', 'err');
      }
    } catch (e) {
      renderStats(null, true);
      setStatus(e instanceof Error ? e.message : String(e), 'err');
    }
  }

  async function postDelete(body, confirmMsg) {
    if (!confirm(confirmMsg)) return;
    setStatus('Deleting…');
    try {
      const res = await fetch(`${apiBase()}/api/history`, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ manage: true, ...body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const r = data.result || {};
      const parts = [];
      if (r.samplesDeleted != null) parts.push(`${r.samplesDeleted} sample(s)`);
      if (r.sessionsDeleted != null) parts.push(`${r.sessionsDeleted} session(s)`);
      if (r.devicesDeleted != null) parts.push(`${r.devicesDeleted} device(s)`);
      setStatus(`Deleted: ${parts.join(', ') || 'done'}.`, 'ok');
      await refreshSummary();
      if (typeof window.reloadDashboardHistory === 'function') {
        void window.reloadDashboardHistory();
      }
      if (typeof window.dashboardRefreshNow === 'function') {
        void window.dashboardRefreshNow();
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), 'err');
    }
  }

  function rangeIso() {
    const deviceId = $('#dataDeleteRangeDeviceId')?.value?.trim();
    const fromDate = $('#dataDeleteFromDate')?.value;
    const fromTime = $('#dataDeleteFromTime')?.value || '00:00';
    const toDate = $('#dataDeleteToDate')?.value;
    const toTime = $('#dataDeleteToTime')?.value || '23:59';
    if (!deviceId || !fromDate || !toDate) {
      throw new Error('Select device, from date, and to date.');
    }
    const from = new Date(`${fromDate}T${fromTime}`).toISOString();
    const to = new Date(`${toDate}T${toTime}`).toISOString();
    return { deviceId, from, to };
  }

  function bind() {
    $('#dataManageRefreshBtn')?.addEventListener('click', () => void refreshSummary());
    $('#dataDeleteSessionBtn')?.addEventListener('click', () => {
      const sessionId = $('#dataDeleteSessionId')?.value?.trim();
      if (!sessionId) {
        setStatus('Select a session to delete.', 'err');
        return;
      }
      void postDelete(
        { action: 'deleteSession', sessionId },
        `Permanently delete session ${sessionId} and all its samples?`,
      );
    });
    $('#dataDeleteDeviceBtn')?.addEventListener('click', () => {
      const uniqueId = $('#dataDeleteDeviceId')?.value?.trim();
      if (!uniqueId) {
        setStatus('Select a device to delete.', 'err');
        return;
      }
      void postDelete(
        { action: 'deleteDevice', uniqueId },
        `Permanently delete ALL stored data for device ${uniqueId}?`,
      );
    });
    $('#dataDeleteRangeBtn')?.addEventListener('click', () => {
      try {
        const { deviceId, from, to } = rangeIso();
        void postDelete(
          { action: 'deleteRange', uniqueId: deviceId, from, to },
          `Permanently delete samples for ${deviceId} from ${from} to ${to}?`,
        );
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e), 'err');
      }
    });
    $('#dataDeleteAllBtn')?.addEventListener('click', () => {
      const confirmText = $('#dataDeleteAllConfirm')?.value?.trim();
      if (confirmText !== DELETE_ALL_CONFIRM) {
        setStatus(`Type exactly: ${DELETE_ALL_CONFIRM}`, 'err');
        return;
      }
      void postDelete(
        { action: 'deleteAll', confirm: DELETE_ALL_CONFIRM },
        'Permanently delete ALL devices, sessions, and samples in the database?',
      );
    });
  }

  window.initDashboardDataManage = function initDashboardDataManage() {
    bind();
    void refreshSummary();
  };

  window.reloadDashboardDataManage = refreshSummary;
})();
