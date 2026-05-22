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
    const { sent, failed } = await flushOutbox(s);
    if (sent || failed) pushLog(`Upload: ${sent} sent, ${failed} failed`);
    await updatePending();
  }

  function render() {
    root.innerHTML = view === 'settings' ? settingsHtml() : recordHtml();
    bind();
  }

  function recordHtml(): string {
    const stats = controller?.getStats();
    return `
      <header class="header">
        <h1>RNZ Row Recorder</h1>
        <div class="header-btns">
          <a class="btn btn-ghost" href="/dashboard.html">Monitor</a>
          <button type="button" class="btn btn-ghost" data-nav="settings">Settings</button>
        </div>
      </header>
      <main class="main">
        <section class="card status-card">
          <div class="status-row">
            <span class="label">Status</span>
            <span class="badge ${recording ? 'badge-live' : ''}">${recording ? 'Recording' : 'Idle'}</span>
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
        <section class="card actions">
          ${
            !recording
              ? `<button type="button" class="btn btn-primary btn-lg" data-action="start">Start session</button>`
              : `
                <button type="button" class="btn btn-secondary" data-action="connect-hr">Connect HR strap</button>
                <button type="button" class="btn btn-danger btn-lg" data-action="stop">Stop session</button>
              `
          }
          <button type="button" class="btn btn-ghost" data-action="sync">Upload queue now</button>
        </section>
        <section class="card toggles-hint">
          <p class="hint">Sensors: GPS ${settings.enableGps ? 'on' : 'off'} · Motion ${settings.enableMotion ? 'on' : 'off'} · HR ${settings.enableHr ? 'on' : 'off'}</p>
          <p class="hint">Device: <strong>${settings.deviceId || '(not set)'}</strong></p>
        </section>
        <section class="card log">
          <h2>Log</h2>
          <pre>${logLines.join('\n') || 'Ready.'}</pre>
        </section>
      </main>
    `;
  }

  function settingsHtml(): string {
    const s = loadSettings();
    return `
      <header class="header">
        <h1>Settings</h1>
        <button type="button" class="btn btn-ghost" data-nav="record">Back</button>
      </header>
      <main class="main">
        <form class="card form" data-settings-form>
          <label>Device ID (Traccar uniqueId)<input name="deviceId" value="${esc(s.deviceId)}" required placeholder="CREW-01" /></label>
          <label>Athlete ID<input name="athleteId" value="${esc(s.athleteId)}" placeholder="optional" /></label>
          <label>Traccar URL (host, port 5055 added if omitted)<input name="traccarUrl" value="${esc(s.traccarUrl)}" placeholder="https://traccar.example.com" /></label>
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
          <button type="submit" class="btn btn-primary">Save settings</button>
        </form>
        <section class="card hint-card">
          <p>Keep screen on during sessions. iOS needs a user tap to connect BLE HR.</p>
          <p>Traccar overlay polls every 3–10s — set GPS interval to 1–3s for live maps.</p>
        </section>
      </main>
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
