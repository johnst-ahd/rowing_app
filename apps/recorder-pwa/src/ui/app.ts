import { loadSettings, saveSettings, settingsFromForm } from '../lib/settings';
import {
  clearRecordingActive,
  getInterruptedRecording,
  markRecordingActive,
  startBackgroundSession,
  stopBackgroundSession,
  type BackgroundStatus,
} from '../lib/background-session';
import { requestNativePermissions } from '@rowing/sensor-adapters';
import { startRecorder, type RecorderController } from '../session/recorder';
import { clearPendingOutbox, countPendingOutbox } from '../session/store';
import { flushOutbox } from '../upload/sync';
import { repairOversizedPendingOutbox } from '../session/store';
import { testIngestConnection } from '../upload/telemetry-api';

type View = 'record' | 'settings';

const IS_NATIVE = import.meta.env.VITE_PLATFORM === 'native';

/** Resolve static assets for web (/) and Capacitor (./). */
function asset(path: string): string {
  const clean = path.replace(/^\//, '');
  return `${import.meta.env.BASE_URL}${clean}`;
}

export function mountApp(root: HTMLElement): void {
  let view: View = 'record';
  let recording = false;
  let capsizeActive = false;
  let backgroundStatus: BackgroundStatus = 'foreground';
  let controller: RecorderController | null = null;
  let syncTimer: ReturnType<typeof setInterval> | null = null;
  let sessionStartedAt: number | null = null;
  let hudTickTimer: ReturnType<typeof setInterval> | null = null;
  let controlsCollapsed = false;
  const settings = loadSettings();

  const logLines: string[] = [];
  const refreshLogPre = () => {
    const pre = root.querySelector('.hub-panel.log pre');
    if (pre) pre.textContent = logLines.join('\n') || 'Ready.';
  };
  const pushLog = (msg: string, rerender = true) => {
    const t = new Date().toLocaleTimeString();
    logLines.unshift(`[${t}] ${msg}`);
    if (logLines.length > 80) logLines.length = 80;
    if (rerender) render();
    else refreshLogPre();
  };

  const updatePending = async () => {
    const n = await countPendingOutbox();
    const el = root.querySelector('[data-pending]');
    if (el) el.textContent = String(n);
  };

  async function runSync(manual = false) {
    if (manual) {
      pushLog('Uploading queued data…');
      if (recording) {
        pushLog('Tip: queue still grows while recording — stop session to freeze queue.', false);
      }
    }
    try {
      const s = loadSettings();
      const pendingBefore = await countPendingOutbox();
      if (manual && pendingBefore === 0) {
        pushLog('Queue is empty — nothing to upload.');
        await updatePending();
        return;
      }

      const { sent, failed, errors } = await flushOutbox(s, {
        force: manual,
        maxBatches: manual ? 15 : 40,
        onProgress: manual ? (msg) => pushLog(msg, false) : undefined,
      });

      const pendingAfter = await countPendingOutbox();
      if (manual || sent || failed) {
        pushLog(`Upload: ${sent} sent, ${failed} failed · queue ${pendingAfter}`);
      }
      if (errors.length) {
        for (const err of errors.slice(0, 3)) pushLog(err, false);
        refreshLogPre();
        render();
        if (/failed to fetch|timed out/i.test(errors[0])) {
          pushLog('Tip: stop session, check signal, Settings → Test upload.');
        }
      } else if (pendingBefore > 0 && sent === 0 && pendingAfter >= pendingBefore) {
        pushLog(`Queue still ${pendingAfter} — tap Upload again or Clear session.`);
      } else if (manual && pendingAfter === 0 && sent > 0) {
        pushLog('All queued data uploaded.');
      } else if (manual && pendingAfter > 0 && sent > 0) {
        pushLog(`${pendingAfter} batch(es) left — tap Upload again.`);
      }
      await updatePending();
    } catch (e) {
      pushLog(`Upload error: ${e instanceof Error ? e.message : String(e)}`);
      await updatePending();
    }
  }

  function logPanelHtml(): string {
    return `
      <section class="hub-panel log">
        <h2>Log</h2>
        <pre>${logLines.join('\n') || 'Ready.'}</pre>
      </section>
    `;
  }

  async function clearQueue(manual = true): Promise<void> {
    const n = await clearPendingOutbox();
    await updatePending();
    if (manual) pushLog(n ? `Cleared ${n} queued batch(es).` : 'Queue was already empty.');
  }

  async function clearSession(): Promise<void> {
    if (recording) {
      if (syncTimer) clearInterval(syncTimer);
      syncTimer = null;
      stopHudTimer();
      sessionStartedAt = null;
      controlsCollapsed = false;
      stopBackgroundSession();
      await controller?.stop();
      controller = null;
      recording = false;
      capsizeActive = false;
      backgroundStatus = 'foreground';
    }
    clearRecordingActive();
    const n = await clearPendingOutbox();
    await updatePending();
    pushLog(
      n
        ? `Session cleared — stopped recording and removed ${n} queued batch(es).`
        : 'Session cleared — stopped recording; queue was empty.',
    );
    render();
  }

  function formatElapsed(ms: number): string {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function formatSplit500m(speedMps: number | undefined): string {
    if (speedMps == null || speedMps < 0.25) return '—';
    const sec = 500 / speedMps;
    const m = Math.floor(sec / 60);
    const s = (sec % 60).toFixed(1);
    return `${m}:${s.padStart(4, '0')}`;
  }

  function stopHudTimer(): void {
    if (hudTickTimer) clearInterval(hudTickTimer);
    hudTickTimer = null;
  }

  function setHudText(sel: string, text: string): void {
    const el = root.querySelector(sel);
    if (el) el.textContent = text;
  }

  function updateLiveHud(): void {
    if (!recording || view !== 'record') return;
    const stats = controller?.getStats();
    const elapsed = sessionStartedAt != null ? Date.now() - sessionStartedAt : 0;

    setHudText('[data-hud-timer]', formatElapsed(elapsed));

    const spm = stats?.strokeRate;
    setHudText(
      '[data-hud-spm]',
      spm != null && spm > 0 ? String(Math.round(spm)) : '—',
    );

    setHudText('[data-hud-hr]', stats?.lastHr != null ? String(stats.lastHr) : '—');
    setHudText('[data-hud-split]', formatSplit500m(stats?.speedMps));

    const capsizeEl = root.querySelector('[data-hud-capsize]');
    if (capsizeEl) {
      if (capsizeActive) capsizeEl.removeAttribute('hidden');
      else capsizeEl.setAttribute('hidden', '');
    }

    const pending = root.querySelector('[data-pending]');
    if (pending) pending.textContent = String(stats?.pendingOutbox ?? 0);

    const statsBar = root.querySelector('.hub-stats-bar');
    if (statsBar) statsBar.innerHTML = recordStatsBar(stats);
  }

  function startHudTimer(): void {
    stopHudTimer();
    updateLiveHud();
    hudTickTimer = setInterval(() => updateLiveHud(), 1000);
  }

  function render() {
    root.innerHTML = view === 'settings' ? settingsHtml() : recordHtml();
    bind();
    if (recording && view === 'record') updateLiveHud();
  }

  function hubHeader(): string {
    return `
      <header class="hub-topbar">
        <div class="hub-topbar-inner">
          <div class="hub-topbar-brands">
            <img src="${asset('altitude-hd-logo.png')}" alt="Altitude HD" class="hub-logo" width="320" height="120" />
            <img src="${asset('assets/rnz/rnz-logo-white.png')}" alt="Rowing New Zealand" class="hub-rnz-logo" width="200" height="80" />
          </div>
          <p class="hub-tagline">GPS, heart rate and accelerometer recorder for RNZ ingest${IS_NATIVE ? ' · Native app' : ''}</p>
        </div>
      </header>
    `;
  }

  function hubFooter(): string {
    return `
      <footer class="ahd-footer">
        Altitude HD · RNZ Row Recorder ·
        <a href="${asset('dashboard.html')}">Monitor</a> ·
        <a href="${asset('install-native.html')}">Install Android app</a> ·
        <a href="https://traccar-overlay.vercel.app/" target="_blank" rel="noopener">Hub</a>
      </footer>
    `;
  }

  function recordStatsBar(stats: ReturnType<RecorderController['getStats']> | undefined): string {
    const device = settings.deviceId || '—';
    const status = capsizeActive ? 'CAPSIZE' : recording ? 'Recording' : 'Idle';
    const statusClass = capsizeActive
      ? 'hub-stats-item--danger'
      : recording
        ? 'hub-stats-item--accent'
        : '';
    const gps = stats?.lastGps
      ? `${stats.lastGps.lat.toFixed(4)}, ${stats.lastGps.lon.toFixed(4)}`
      : 'No GPS fix';
    const spm =
      stats?.strokeRate != null ? `${stats.strokeRate} spm` : recording ? 'SPM —' : '';
    const bg =
      recording && backgroundStatus === 'background'
        ? 'Background'
        : recording && settings.enableBackgroundRecording
          ? 'Background ready'
          : '';
    return `
      <span class="hub-stats-item ${statusClass}">${status}</span>
      <span class="hub-stats-sep" aria-hidden="true">·</span>
      <span class="hub-stats-item">Device: ${esc(device)}</span>
      ${spm ? `<span class="hub-stats-sep" aria-hidden="true">·</span><span class="hub-stats-item">${esc(spm)}</span>` : ''}
      ${bg ? `<span class="hub-stats-sep" aria-hidden="true">·</span><span class="hub-stats-item hub-stats-item--muted">${esc(bg)}</span>` : ''}
      <span class="hub-stats-sep" aria-hidden="true">·</span>
      <span class="hub-stats-item">${gps}</span>
    `;
  }

  function liveHudHtml(): string {
    return `
      <section class="session-live-hud" aria-live="polite">
        <div class="session-live-hud__alert" data-hud-capsize ${capsizeActive ? '' : 'hidden'} role="alert">
          ⚠ CAPSIZE — boat tipped. Check crew now.
        </div>
        <div class="session-live-hud__metrics">
          <div class="session-metric session-metric--timer">
            <span class="session-metric__value" data-hud-timer>0:00</span>
            <span class="session-metric__label">Time</span>
          </div>
          <div class="session-metric">
            <span class="session-metric__value" data-hud-spm>—</span>
            <span class="session-metric__label">Stroke /min</span>
          </div>
          <div class="session-metric">
            <span class="session-metric__value" data-hud-hr>—</span>
            <span class="session-metric__label">HR</span>
          </div>
          <div class="session-metric">
            <span class="session-metric__value" data-hud-split>—</span>
            <span class="session-metric__label">Pace /500m</span>
          </div>
        </div>
      </section>
    `;
  }

  function recordDrawerHtml(stats: ReturnType<RecorderController['getStats']> | undefined): string {
    return `
      <div class="ahd-toolbar">
        <h1>Session</h1>
        <div class="ahd-toolbar-actions">
          <a class="hub-btn hub-btn--ghost" href="${asset('dashboard.html')}">Monitor</a>
          <button type="button" class="hub-btn" data-nav="settings">Settings</button>
        </div>
      </div>
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
        <button type="button" class="hub-btn hub-btn--ghost" data-action="clear-queue">Clear upload queue</button>
        <button type="button" class="hub-btn hub-btn--ghost" data-action="clear-session">Clear session</button>
      </section>
      ${
        recording
          ? `
            <section class="hub-panel">
              <h2 class="hub-section-title">Details</h2>
              <div class="stats-grid">
                <div><span class="stat-val" data-stat="gps">${stats?.gpsCount ?? 0}</span><span class="stat-lbl">GPS</span></div>
                <div><span class="stat-val" data-stat="motion">${stats?.motionCount ?? 0}</span><span class="stat-lbl">Motion</span></div>
                <div><span class="stat-val" data-stat="tilt">${stats?.tiltDeg != null ? stats.tiltDeg.toFixed(0) : '—'}</span><span class="stat-lbl">Tilt °</span></div>
                <div><span class="stat-val" data-pending>${stats?.pendingOutbox ?? 0}</span><span class="stat-lbl">Queued</span></div>
              </div>
              ${
                stats?.lastGps
                  ? `<p class="coords">${stats.lastGps.lat.toFixed(5)}, ${stats.lastGps.lon.toFixed(5)}</p>`
                  : ''
              }
            </section>
          `
          : `
            <section class="hub-panel">
              <p class="hint">Set a <strong>Device ID</strong> in Settings, then start a session. Live timer, stroke rate, HR, and pace appear at the top while recording.</p>
            </section>
          `
      }
      <section class="hub-panel toggles-hint">
        <p class="hint">Sensors: GPS ${settings.enableGps ? 'on' : 'off'} · Motion ${settings.enableMotion ? 'on' : 'off'} · HR ${settings.enableHr ? 'on' : 'off'}</p>
        <p class="hint">Device: <strong>${esc(settings.deviceId || '(not set)')}</strong></p>
        ${
          recording
            ? `<p class="hint hint--background">Native app: <strong>Location → Always</strong>, notifications, battery <strong>Unrestricted</strong>. Do not force-close while recording.</p>`
            : ''
        }
      </section>
      ${logPanelHtml()}
    `;
  }

  function recordHtml(): string {
    const stats = controller?.getStats();
    const shellClass = recording ? 'ahd-recorder-shell ahd-recorder-shell--recording' : 'ahd-recorder-shell';
    return `
      <div class="${shellClass}">
        ${hubHeader()}
        <div class="hub-stats-bar" aria-live="polite">${recordStatsBar(stats)}</div>
        ${recording ? liveHudHtml() : ''}
        ${
          recording
            ? `<button type="button" class="hub-btn hub-btn--ghost session-drawer-toggle" data-action="toggle-drawer" aria-expanded="${!controlsCollapsed}">
                ${controlsCollapsed ? 'Show controls & log ▼' : 'Hide controls & log ▲'}
              </button>`
            : ''
        }
        <div class="ahd-recorder-main">
          <div class="session-drawer ${controlsCollapsed && recording ? 'session-drawer--collapsed' : ''}" data-drawer>
            ${recordDrawerHtml(stats)}
          </div>
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
            <label>Ingest API URL<input name="ingestUrl" value="${esc(s.ingestUrl)}" placeholder="https://rowing-app-recorder-pwa.vercel.app/api/ingest" /></label>
            <label>Ingest token<input name="ingestToken" type="password" value="${esc(s.ingestToken)}" autocomplete="off" /></label>
            <fieldset class="fieldset">
              <legend>Sample rates (ms)</legend>
              <label>GPS interval<input name="gpsIntervalMs" type="number" min="500" step="100" value="${s.gpsIntervalMs}" /></label>
              <label>Motion interval (analysis)<input name="motionIntervalMs" type="number" min="20" step="10" value="${s.motionIntervalMs}" /></label>
              <label>Motion upload interval (no GPS)<input name="motionUploadIntervalMs" type="number" min="200" step="100" value="${s.motionUploadIntervalMs ?? 500}" /></label>
              <label>Upload batch interval<input name="uploadBatchMs" type="number" min="1000" step="500" value="${s.uploadBatchMs}" /></label>
              <p class="hint">With GPS + accelerometer, motion is analyzed at full rate but only uploaded on each GPS fix (~1/s) so uploads keep up.</p>
            </fieldset>
            <fieldset class="fieldset checks">
              <legend>Sensors</legend>
              <label class="check"><input type="checkbox" name="enableGps" ${s.enableGps ? 'checked' : ''} /> GPS</label>
              <label class="check"><input type="checkbox" name="enableMotion" ${s.enableMotion ? 'checked' : ''} /> Accelerometer</label>
              <label class="check"><input type="checkbox" name="enableHr" ${s.enableHr ? 'checked' : ''} /> Heart rate (BLE)</label>
            </fieldset>
            <fieldset class="fieldset checks">
              <legend>Background recording</legend>
              <label class="check"><input type="checkbox" name="enableBackgroundRecording" ${s.enableBackgroundRecording !== false ? 'checked' : ''} /> Allow background (best effort)</label>
              <label class="check"><input type="checkbox" name="keepScreenOn" ${s.keepScreenOn !== false ? 'checked' : ''} /> Keep screen on while recording</label>
            </fieldset>
            <button type="submit" class="hub-btn hub-btn--primary">Save settings</button>
            <button type="button" class="hub-btn" data-action="test-ingest">Test upload connection</button>
            <button type="button" class="hub-btn" data-action="sync">Upload queue now</button>
            <button type="button" class="hub-btn" data-action="clear-queue">Clear upload queue</button>
            <button type="button" class="hub-btn" data-action="clear-session">Clear session</button>
          </form>
          ${logPanelHtml()}
          <section class="hub-panel hint-card">
            <p>All sensors upload to your RNZ ingest API only (no Traccar on the phone).</p>
            <p>Native APK: background GPS uses a system notification (Android) or blue status bar (iOS). Web PWA: add to home screen — background is limited compared to the native app.</p>
            <p>iOS needs a user tap to connect BLE HR. Sensors may pause if the app is swiped away.</p>
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

    root.querySelector('[data-action="test-ingest"]')?.addEventListener('click', async () => {
      const form = root.querySelector('[data-settings-form]') as HTMLFormElement | null;
      if (!form) return;
      const draft = settingsFromForm(form);
      pushLog(`Testing ${draft.ingestUrl}…`);
      try {
        const msg = await testIngestConnection(
          draft.ingestUrl,
          draft.ingestToken,
          draft.deviceId,
        );
        pushLog(msg);
      } catch (e) {
        pushLog(e instanceof Error ? e.message : String(e));
      }
    });

    root.querySelector('[data-action="start"]')?.addEventListener('click', async () => {
      const s = loadSettings();
      if (IS_NATIVE) {
        await requestNativePermissions();
      }
      sessionStartedAt = Date.now();
      controlsCollapsed = true;

      controller = await startRecorder(
        s,
        () => updateLiveHud(),
        pushLog,
        async (n) => {
          const el = root.querySelector('[data-pending]');
          if (el) el.textContent = String(n);
          updateLiveHud();
        },
        (active) => {
          capsizeActive = active;
          updateLiveHud();
        },
        {
          onBackgroundPulse: () => void runSync(false),
        },
      );
      if (!controller) return;

      recording = true;
      backgroundStatus = 'foreground';
      markRecordingActive(controller.sessionId, s.deviceId);

      await startBackgroundSession(s, {
        onFlush: () => controller!.flush(),
        onSync: runSync,
        onLog: pushLog,
        onStatus: (status) => {
          backgroundStatus = status;
          render();
        },
      });

      if (s.enableHr) pushLog('Use Connect HR strap when ready.');
      const batchMs = s.enableMotion ? Math.max(s.uploadBatchMs, 8000) : s.uploadBatchMs;
      const syncInterval = Math.max(4000, Math.min(batchMs, 12000));
      syncTimer = setInterval(() => void runSync(false), syncInterval);
      void runSync(false);
      render();
      startHudTimer();
    });

    root.querySelector('[data-action="stop"]')?.addEventListener('click', async () => {
      if (syncTimer) clearInterval(syncTimer);
      stopHudTimer();
      sessionStartedAt = null;
      controlsCollapsed = false;
      stopBackgroundSession();
      await controller?.stop();
      controller = null;
      recording = false;
      capsizeActive = false;
      backgroundStatus = 'foreground';
      clearRecordingActive();
      await runSync(true);
      render();
    });

    root.querySelector('[data-action="toggle-drawer"]')?.addEventListener('click', () => {
      controlsCollapsed = !controlsCollapsed;
      render();
    });

    root.querySelector('[data-action="connect-hr"]')?.addEventListener('click', () => {
      void controller?.connectHr();
    });

    root.querySelectorAll('[data-action="sync"]').forEach((el) => {
      el.addEventListener('click', () => void runSync(true));
    });

    root.querySelectorAll('[data-action="clear-queue"]').forEach((el) => {
      el.addEventListener('click', () => {
        if (recording) {
          pushLog('Stop the session before clearing the queue.');
          return;
        }
        void clearQueue(true);
      });
    });

    root.querySelectorAll('[data-action="clear-session"]').forEach((el) => {
      el.addEventListener('click', () => {
        void clearSession();
      });
    });

    void updatePending();
  }

  render();
  void repairOversizedPendingOutbox().then((n) => {
    if (n > 0) pushLog(`Split ${n} oversized queued batch(es) for upload.`);
  });
  const interrupted = getInterruptedRecording();
  if (interrupted) {
    pushLog(
      `Previous session may have ended unexpectedly (${interrupted.deviceId}, ${new Date(interrupted.startedAt).toLocaleTimeString()}). Check upload queue.`,
    );
    clearRecordingActive();
  }
  pushLog('RNZ Row Recorder ready. Configure settings, then start a session.');
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}
