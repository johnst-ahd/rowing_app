import { loadSettings, saveSettings, settingsFromForm } from '../lib/settings';
import { startRecorder, type RecorderController } from '../session/recorder';
import { countPendingOutbox } from '../session/store';
import { flushOutbox } from '../upload/sync';

type View = 'record' | 'settings';

export function mountApp(root: HTMLElement): void {
  let view: View = 'record';
  let recording = false;
  let controller: RecorderController | null = null;
  let syncTimer: ReturnType<typeof setInterval> | null = null;
  const settings = loadSettings();

  const logLines: string[] = [];
  const pushLog = (msg: string) => {
    const t = new Date().toLocaleTimeString();
    logLines.unshift(`[${t}] ${msg}`);
    if (logLines.length > 80) logLines.length = 80;
    render();
  };

  const updatePending = async () => {
    const n = await countPendingOutbox();
    const el = root.querySelector('[data-pending]');
    if (el) el.textContent = String(n);
  };

  async function runSync() {
    const s = loadSettings();
    const { sent, failed, errors } = await flushOutbox(s);
    if (sent || failed) pushLog(`Upload: ${sent} sent, ${failed} failed`);
    if (errors.length) pushLog(errors[0]);
    await updatePending();
  }

  function render() {
    root.innerHTML = view === 'settings' ? settingsHtml() : recordHtml();
    bind();
  }

  function hubHeader(): string {
    return `
      <header class="hub-topbar">
        <div class="hub-topbar-inner">
          <div class="hub-topbar-brands">
            <img src="/altitude-hd-logo.png" alt="Altitude HD" class="hub-logo" width="320" height="120" />
            <img src="/assets/rnz/rnz-logo-white.png" alt="Rowing New Zealand" class="hub-rnz-logo" width="200" height="80" />
          </div>
          <p class="hub-tagline">GPS, heart rate and accelerometer recorder for RNZ ingest</p>
        </div>
      </header>
    `;
  }

  function hubFooter(): string {
    return `
      <footer class="ahd-footer">
        Altitude HD · RNZ Row Recorder ·
        <a href="/dashboard.html">Monitor</a> ·
        <a href="https://traccar-overlay.vercel.app/" target="_blank" rel="noopener">Hub</a>
      </footer>
    `;
  }

  function recordStatsBar(stats: ReturnType<RecorderController['getStats']> | undefined): string {
    const device = settings.deviceId || '—';
    const status = recording ? 'Recording' : 'Idle';
    const statusClass = recording ? 'hub-stats-item--accent' : '';
    const gps = stats?.lastGps
      ? `${stats.lastGps.lat.toFixed(4)}, ${stats.lastGps.lon.toFixed(4)}`
      : 'No GPS fix';
    return `
      <span class="hub-stats-item ${statusClass}">${status}</span>
      <span class="hub-stats-sep" aria-hidden="true">·</span>
      <span class="hub-stats-item">Device: ${esc(device)}</span>
      <span class="hub-stats-sep" aria-hidden="true">·</span>
      <span class="hub-stats-item">${gps}</span>
    `;
  }

  function recordHtml(): string {
    const stats = controller?.getStats();
    return `
      <div class="ahd-recorder-shell">
        ${hubHeader()}
        <div class="hub-stats-bar" aria-live="polite">${recordStatsBar(stats)}</div>
        <div class="ahd-recorder-main">
          <div class="ahd-toolbar">
            <h1>Session</h1>
            <div class="ahd-toolbar-actions">
              <a class="hub-btn hub-btn--ghost" href="/dashboard.html">Monitor</a>
              <button type="button" class="hub-btn" data-nav="settings">Settings</button>
            </div>
          </div>
          <section class="hub-panel">
            <h2 class="hub-section-title">Live session</h2>
            <div class="status-row">
              <span class="label">Status</span>
              <span class="badge-pill ${recording ? 'badge-pill--live' : 'badge-pill--idle'}">${recording ? 'Recording' : 'Idle'}</span>
            </div>
            <div class="stats-grid">
              <div><span class="stat-val" data-stat="gps">${stats?.gpsCount ?? 0}</span><span class="stat-lbl">GPS</span></div>
              <div><span class="stat-val" data-stat="motion">${stats?.motionCount ?? 0}</span><span class="stat-lbl">Motion</span></div>
              <div><span class="stat-val" data-stat="hr">${stats?.lastHr ?? '—'}</span><span class="stat-lbl">HR bpm</span></div>
              <div><span class="stat-val" data-pending>0</span><span class="stat-lbl">Queued</span></div>
            </div>
            ${
              stats?.lastGps
                ? `<p class="coords">${stats.lastGps.lat.toFixed(5)}, ${stats.lastGps.lon.toFixed(5)}</p>`
                : ''
            }
          </section>
          <section class="hub-panel actions">
            ${
              !recording
                ? `<button type="button" class="hub-btn hub-btn--primary hub-btn-lg" data-action="start">Start session</button>`
                : `
                  <button type="button" class="hub-btn" data-action="connect-hr">Connect HR strap</button>
                  <button type="button" class="hub-btn hub-btn--danger hub-btn-lg" data-action="stop">Stop session</button>
                `
            }
            <button type="button" class="hub-btn hub-btn--ghost" data-action="sync">Upload queue now</button>
          </section>
          <section class="hub-panel toggles-hint">
            <p class="hint">Sensors: GPS ${settings.enableGps ? 'on' : 'off'} · Motion ${settings.enableMotion ? 'on' : 'off'} · HR ${settings.enableHr ? 'on' : 'off'}</p>
            <p class="hint">Device: <strong>${esc(settings.deviceId || '(not set)')}</strong></p>
          </section>
          <section class="hub-panel log">
            <h2>Log</h2>
            <pre>${logLines.join('\n') || 'Ready.'}</pre>
          </section>
        </div>
        ${hubFooter()}
      </div>
    `;
  }

  function settingsHtml(): string {
    const s = loadSettings();
    return `
      <div class="ahd-recorder-shell">
        ${hubHeader()}
        <div class="hub-stats-bar">
          <span class="hub-stats-item hub-stats-item--accent">Settings</span>
        </div>
        <div class="ahd-recorder-main">
          <div class="ahd-toolbar">
            <h1>Settings</h1>
            <div class="ahd-toolbar-actions">
              <button type="button" class="hub-btn" data-nav="record">Back</button>
            </div>
          </div>
          <form class="hub-panel form" data-settings-form>
            <h2 class="hub-section-title">Device &amp; upload</h2>
            <label>Device ID<input name="deviceId" value="${esc(s.deviceId)}" required placeholder="CREW-01" /></label>
            <label>Athlete ID<input name="athleteId" value="${esc(s.athleteId)}" placeholder="optional" /></label>
            <label>Ingest API URL<input name="ingestUrl" value="${esc(s.ingestUrl)}" /></label>
            <label>Ingest token<input name="ingestToken" type="password" value="${esc(s.ingestToken)}" autocomplete="off" /></label>
            <fieldset class="fieldset">
              <legend>Sample rates (ms)</legend>
              <label>GPS interval<input name="gpsIntervalMs" type="number" min="500" step="100" value="${s.gpsIntervalMs}" /></label>
              <label>Motion interval<input name="motionIntervalMs" type="number" min="20" step="10" value="${s.motionIntervalMs}" /></label>
              <label>Upload batch interval<input name="uploadBatchMs" type="number" min="1000" step="500" value="${s.uploadBatchMs}" /></label>
            </fieldset>
            <fieldset class="fieldset checks">
              <legend>Sensors</legend>
              <label class="check"><input type="checkbox" name="enableGps" ${s.enableGps ? 'checked' : ''} /> GPS</label>
              <label class="check"><input type="checkbox" name="enableMotion" ${s.enableMotion ? 'checked' : ''} /> Accelerometer</label>
              <label class="check"><input type="checkbox" name="enableHr" ${s.enableHr ? 'checked' : ''} /> Heart rate (BLE)</label>
            </fieldset>
            <button type="submit" class="hub-btn hub-btn--primary">Save settings</button>
          </form>
          <section class="hub-panel hint-card">
            <p>All sensors upload to your RNZ ingest API only (no Traccar on the phone).</p>
            <p>Keep screen on during sessions. iOS needs a user tap to connect BLE HR.</p>
          </section>
        </div>
        ${hubFooter()}
      </div>
    `;
  }

  function bind() {
    root.querySelector('[data-nav="settings"]')?.addEventListener('click', () => {
      view = 'settings';
      render();
    });
    root.querySelector('[data-nav="record"]')?.addEventListener('click', () => {
      view = 'record';
      render();
    });

    root.querySelector('[data-settings-form]')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      saveSettings(settingsFromForm(form));
      pushLog('Settings saved.');
      view = 'record';
      render();
    });

    root.querySelector('[data-action="start"]')?.addEventListener('click', async () => {
      const s = loadSettings();
      try {
        if ('wakeLock' in navigator) {
          await (navigator as Navigator & { wakeLock: { request: (t: string) => Promise<unknown> } }).wakeLock.request('screen');
        }
      } catch {
        /* optional */
      }
      controller = await startRecorder(
        s,
        () => render(),
        pushLog,
        async (n) => {
          const el = root.querySelector('[data-pending]');
          if (el) el.textContent = String(n);
        },
      );
      if (!controller) return;
      recording = true;
      if (s.enableHr) pushLog('Use Connect HR strap when ready.');
      syncTimer = setInterval(() => void runSync(), s.uploadBatchMs);
      void runSync();
      render();
    });

    root.querySelector('[data-action="stop"]')?.addEventListener('click', async () => {
      if (syncTimer) clearInterval(syncTimer);
      await controller?.stop();
      controller = null;
      recording = false;
      await runSync();
      render();
    });

    root.querySelector('[data-action="connect-hr"]')?.addEventListener('click', () => {
      void controller?.connectHr();
    });

    root.querySelector('[data-action="sync"]')?.addEventListener('click', () => void runSync());

    void updatePending();
  }

  render();
  pushLog('RNZ Row Recorder ready. Configure settings, then start a session.');
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}
