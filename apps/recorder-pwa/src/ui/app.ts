import {
  loadSettings,
  sampleRateSecFromSettings,
  saveSettings,
  settingsFromForm,
} from '../lib/settings';
import {
  clearRecordingActive,
  getInterruptedRecording,
  markRecordingActive,
  startBackgroundSession,
  stopBackgroundSession,
  type BackgroundStatus,
} from '../lib/background-session';
import { requestNativePermissions } from '@rowing/sensor-adapters';
import { setNativeLiveMapMode } from '../lib/native-capsize-monitor';
import { startRecorder, type RecorderController } from '../session/recorder';
import { clearPendingOutbox, countPendingOutbox } from '../session/store';
import { flushOutbox } from '../upload/sync';
import { repairOversizedPendingOutbox } from '../session/store';
import {
  formatSplit500m,
  hrToT,
  MetricRollingAvg,
  SPEED_AVG_WINDOW_MS,
  STROKE_AVG_WINDOW_MS,
  splitSecFromMps,
  splitSecToT,
  updateSpectrumRail,
} from './session-display';

type View = 'record' | 'settings';

const IS_NATIVE = import.meta.env.VITE_PLATFORM === 'native';
const IS_KRI = import.meta.env.VITE_APP_BRAND === 'kri';
const APP_VERSION = import.meta.env.VITE_APP_VERSION;
const APP_VERSION_CODE = import.meta.env.VITE_APP_VERSION_CODE;

function buildVersionLabel(): string {
  if (!APP_VERSION) return '';
  if (IS_NATIVE && APP_VERSION_CODE) {
    return `Build v${APP_VERSION} (${APP_VERSION_CODE})`;
  }
  return `Build v${APP_VERSION}`;
}

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
  let logExpanded = false;
  const speedAvg = new MetricRollingAvg(SPEED_AVG_WINDOW_MS, 0.15);
  const strokeRateAvg = new MetricRollingAvg(STROKE_AVG_WINDOW_MS, 0);
  const settings = loadSettings();

  document.addEventListener('fullscreenchange', () => {
    const stage = root.querySelector('[data-session-stage]');
    if (!stage) return;
    stage.classList.toggle(
      'session-stage--fullscreen',
      document.fullscreenElement === stage,
    );
    const btn = root.querySelector('[data-action="toggle-fullscreen"]');
    if (btn) {
      btn.textContent =
        document.fullscreenElement === stage ? 'Exit fullscreen' : 'Fullscreen';
    }
  });

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
      if (recording && pendingAfter >= 120) {
        pushLog(
          `Queue pressure HIGH (${pendingAfter}) — check signal or raise upload interval.`,
          false,
        );
      } else if (recording && pendingAfter >= 60) {
        pushLog(`Queue pressure rising (${pendingAfter}) — watch upload status.`, false);
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
      <section class="hub-panel log ${logExpanded ? 'log--open' : 'log--closed'}">
        <button type="button" class="log-toggle hub-btn hub-btn--ghost" data-action="toggle-log" aria-expanded="${logExpanded}">
          Log ${logExpanded ? '▲ hide' : '▼ show'}
        </button>
        ${logExpanded ? `<pre>${logLines.join('\n') || 'Ready.'}</pre>` : ''}
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
      speedAvg.clear();
      strokeRateAvg.clear();
      void exitStageFullscreen();
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

  async function exitStageFullscreen(): Promise<void> {
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        /* ignore */
      }
    }
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
    if (spm != null && spm > 0) strokeRateAvg.push(spm);
    const avgSpm = strokeRateAvg.average();
    const displaySpm =
      spm != null && spm > 0
        ? String(Math.round(spm))
        : avgSpm != null && avgSpm > 0
          ? String(Math.round(avgSpm))
          : '—';
    setHudText('[data-hud-spm]', displaySpm);

    setHudText('[data-hud-hr]', stats?.lastHr != null ? String(stats.lastHr) : '—');

    if (stats?.speedMps != null && stats.speedMps >= 0.15) {
      speedAvg.push(stats.speedMps);
    }
    const avgMps = speedAvg.average();
    setHudText('[data-hud-split]', formatSplit500m(avgMps));

    if (IS_KRI) {
      setHudText('[data-hud-device]', settings.deviceId || '(device not set)');
      const lastGpsMs = stats?.lastGps?.t ?? 0;
      const gpsActive = lastGpsMs > 0 && Date.now() - lastGpsMs <= 30_000;
      const gpsEl = root.querySelector('[data-hud-gps-status]');
      if (gpsEl) {
        gpsEl.textContent = gpsActive ? 'GPS active (last 30s)' : 'GPS waiting…';
        gpsEl.setAttribute('data-gps-active', gpsActive ? 'true' : 'false');
      }
    }

    const splitSec = splitSecFromMps(avgMps);
    updateSpectrumRail(
      root.querySelector('[data-rail-speed]') as HTMLElement | null,
      splitSec != null ? splitSecToT(splitSec) : undefined,
    );
    const hr = stats?.lastHr;
    updateSpectrumRail(
      root.querySelector('[data-rail-hr]') as HTMLElement | null,
      hr != null && hr > 0 ? hrToT(hr) : undefined,
    );

    const capsizeEl = root.querySelector('[data-hud-capsize]');
    if (capsizeEl) {
      if (capsizeActive) capsizeEl.removeAttribute('hidden');
      else capsizeEl.setAttribute('hidden', '');
    }

    const regattaEl = root.querySelector('[data-hud-regatta]');
    if (regattaEl) {
      const text = stats?.regattaMessage?.text?.trim();
      const textEl = regattaEl.querySelector('[data-hud-regatta-text]');
      if (text) {
        regattaEl.removeAttribute('hidden');
        if (textEl) textEl.textContent = text;
      } else {
        regattaEl.setAttribute('hidden', '');
        if (textEl) textEl.textContent = '';
      }
    }

    const zoneEl = root.querySelector('[data-hud-zone]');
    if (zoneEl) {
      const label = zoneEl.querySelector('.session-zone-badge__label');
      const sub = zoneEl.querySelector('.session-zone-badge__sub');
      if (!stats?.lastGps) {
        zoneEl.setAttribute('data-zone', 'unknown');
        if (label) label.textContent = 'Locating…';
        if (sub) sub.textContent = '';
      } else if (stats.inBoatPark) {
        zoneEl.setAttribute('data-zone', 'boat_park');
        if (label) label.textContent = 'In boat park';
        if (sub) sub.textContent = stats.boatParkName ? stats.boatParkName : '';
      } else {
        zoneEl.setAttribute('data-zone', 'on_water');
        if (label) label.textContent = 'On water';
        if (sub) sub.textContent = '';
      }
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
    if (IS_KRI) {
      return `
      <header class="hub-topbar">
        <div class="hub-topbar-inner">
          <div class="hub-topbar-brands hub-topbar-brands--kri">
            <img src="${asset('assets/kri/kri-logo.png')}" alt="Karāpiro Rowing Inc" class="hub-kri-logo" width="96" height="96" />
            <div class="hub-kri-titles">
              <p class="hub-kicker">KRI Safety System</p>
              <p class="hub-tagline">GPS + capsize safety${IS_NATIVE ? ' · Native app' : ''}</p>
            </div>
          </div>
        </div>
      </header>
    `;
    }
    return `
      <header class="hub-topbar">
        <div class="hub-topbar-inner">
          <div class="hub-topbar-brands">
            <img src="${asset('assets/rnz/rnz-logo-white.png')}" alt="Rowing New Zealand" class="hub-rnz-logo hub-rnz-logo--recorder" width="280" height="112" />
          </div>
          <p class="hub-tagline hub-tagline--title">Row Recorder${IS_NATIVE ? ' · Native app' : ''}</p>
        </div>
      </header>
    `;
  }

  function hubFooter(): string {
    const version = buildVersionLabel();
    const appName = IS_KRI ? 'KRI GPS' : 'RNZ Row Recorder';
    const installLink = IS_KRI
      ? `<a href="${asset('install-kri.html')}">Install Android app</a> ·`
      : `<a href="${asset('install-native.html')}">Install Android app</a> ·`;
    return `
      <footer class="ahd-footer">
        <p class="ahd-footer__line">
          Altitude HD · ${appName} ·
          ${installLink}
          <a href="${asset('dashboard.html')}" target="_blank" rel="noopener">Monitor</a> ·
          <a href="https://traccar-overlay.vercel.app/" target="_blank" rel="noopener">Hub</a>
        </p>
        ${version ? `<p class="ahd-footer__version">${esc(version)}</p>` : ''}
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
    let zone = '';
    if (recording && stats?.lastGps) {
      zone = stats.inBoatPark
        ? stats.boatParkName
          ? `In boat park: ${stats.boatParkName}`
          : 'In boat park'
        : 'On water';
    } else if (recording) {
      zone = 'Locating…';
    }
    return `
      <span class="hub-stats-item ${statusClass}">${status}</span>
      <span class="hub-stats-sep" aria-hidden="true">·</span>
      <span class="hub-stats-item">Device: ${esc(device)}</span>
      ${zone ? `<span class="hub-stats-sep" aria-hidden="true">·</span><span class="hub-stats-item ${stats?.inBoatPark ? 'hub-stats-item--boat-park' : 'hub-stats-item--on-water'}">${esc(zone)}</span>` : ''}
      ${spm ? `<span class="hub-stats-sep" aria-hidden="true">·</span><span class="hub-stats-item">${esc(spm)}</span>` : ''}
      ${bg ? `<span class="hub-stats-sep" aria-hidden="true">·</span><span class="hub-stats-item hub-stats-item--muted">${esc(bg)}</span>` : ''}
      <span class="hub-stats-sep" aria-hidden="true">·</span>
      <span class="hub-stats-item">${gps}</span>
    `;
  }

  function spectrumRailsHtml(): string {
    return `
      <div class="spectrum-rail spectrum-rail--speed" data-rail-speed aria-label="Pace spectrum: fast 1:15 top, slow 2:30 bottom">
        <span class="spectrum-rail__marker" data-rail-marker></span>
        <span class="spectrum-rail__legend">Pace</span>
        <span class="spectrum-rail__fast">1:15</span>
        <span class="spectrum-rail__slow">2:30</span>
      </div>
      <div class="spectrum-rail spectrum-rail--hr" data-rail-hr aria-label="Heart rate spectrum: 200 top, 100 bottom">
        <span class="spectrum-rail__marker" data-rail-marker></span>
        <span class="spectrum-rail__legend">HR</span>
        <span class="spectrum-rail__fast">200</span>
        <span class="spectrum-rail__slow">100</span>
      </div>
    `;
  }

  function liveHudHtml(): string {
    const regattaText = controller?.getStats()?.regattaMessage?.text?.trim() || '';
    return `
      <section class="session-live-hud" aria-live="polite">
        ${
          IS_KRI
            ? `
        <div class="session-live-hud__kri">
          <div class="session-live-hud__device" data-hud-device>${esc(settings.deviceId || '(device not set)')}</div>
          <div class="session-live-hud__gps-status" data-hud-gps-status data-gps-active="false">
            GPS waiting…
          </div>
        </div>
        `
            : ''
        }
        <div class="session-live-hud__alert" data-hud-capsize ${capsizeActive ? '' : 'hidden'} role="alert">
          ⚠ CAPSIZE — boat tipped. Check crew now.
        </div>
        <div class="session-live-hud__regatta" data-hud-regatta ${regattaText ? '' : 'hidden'} role="status" aria-live="polite">
          <span class="session-live-hud__regatta-label">Regatta control</span>
          <p class="session-live-hud__regatta-text" data-hud-regatta-text>${regattaText ? esc(regattaText) : ''}</p>
        </div>
        <div class="session-zone-badge" data-hud-zone data-zone="unknown" aria-live="polite">
          <span class="session-zone-badge__label">Locating…</span>
          <span class="session-zone-badge__sub"></span>
        </div>
        <div class="session-live-hud__metrics">
          <div class="session-metric session-metric--timer">
            <span class="session-metric__value" data-hud-timer>0:00</span>
            <span class="session-metric__label">Time</span>
          </div>
          <div class="session-metric session-metric--spm">
            <span class="session-metric__value" data-hud-spm>—</span>
            <span class="session-metric__label">Strokes /min</span>
          </div>
          <div class="session-metric">
            <span class="session-metric__value" data-hud-hr>—</span>
            <span class="session-metric__label">HR</span>
          </div>
          <div class="session-metric">
            <span class="session-metric__value" data-hud-split>—</span>
            <span class="session-metric__label">Pace /500m <span class="session-metric__sub">10s avg</span></span>
          </div>
        </div>
        <div class="session-live-hud__bar">
          <button type="button" class="hub-btn hub-btn--ghost session-live-hud__fs" data-action="toggle-fullscreen">Fullscreen</button>
        </div>
      </section>
    `;
  }

  function wrapRecordingStage(body: string): string {
    return `
      <div class="session-stage" data-session-stage>
        ${spectrumRailsHtml()}
        <div class="session-stage__inner">${body}</div>
      </div>
    `;
  }

  function recordDrawerHtml(stats: ReturnType<RecorderController['getStats']> | undefined): string {
    return `
      <div class="ahd-toolbar">
        <h1>Session</h1>
        <div class="ahd-toolbar-actions">
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
          : ''
      }
      ${logPanelHtml()}
    `;
  }

  function recordHtml(): string {
    const stats = controller?.getStats();
    const shellClass = recording ? 'ahd-recorder-shell ahd-recorder-shell--recording' : 'ahd-recorder-shell';
    const shell = `
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
    return recording ? wrapRecordingStage(shell) : shell;
  }

  function settingsHtml(): string {
    const s = loadSettings();
    const sampleSec = sampleRateSecFromSettings(s);
    return `
      <div class="ahd-recorder-shell">
        ${hubHeader()}
        <div class="hub-stats-bar">
          <span class="hub-stats-item hub-stats-item--accent">Settings</span>
        </div>
        <div class="ahd-recorder-main ahd-recorder-main--settings">
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
            <label>Ingest token<input class="form-input-light" name="ingestToken" type="password" value="${esc(s.ingestToken)}" autocomplete="off" /></label>
            <label>Sample interval (seconds)<input class="form-input-light" name="sampleRateSec" type="number" min="0.5" step="0.5" value="${sampleSec}" inputmode="decimal" /></label>
            <fieldset class="fieldset checks">
              <legend>Sensors</legend>
              <label class="check"><input type="checkbox" name="enableGps" ${s.enableGps ? 'checked' : ''} /> GPS</label>
              <label class="check"><input type="checkbox" name="enableMotion" ${s.enableMotion ? 'checked' : ''} /> Accelerometer</label>
              <label class="check"><input type="checkbox" name="enableHr" ${s.enableHr ? 'checked' : ''} /> Heart rate (BLE)</label>
            </fieldset>
            <fieldset class="fieldset checks">
              <legend>Fleet map</legend>
              <label class="check"><input type="checkbox" name="liveMapMode" ${s.liveMapMode ? 'checked' : ''} /> Faster phone uploads <span class="form-hint">(optional ~2.5 s GPS upload — uses more battery; dashboard smooth map does not need this)</span></label>
            </fieldset>
            <fieldset class="fieldset checks">
              <legend>Background recording</legend>
              <label class="check"><input type="checkbox" name="enableBackgroundRecording" ${s.enableBackgroundRecording !== false ? 'checked' : ''} ${IS_NATIVE ? 'disabled' : ''} /> ${IS_NATIVE ? 'Always on in native app' : 'Allow background (best effort)'}</label>
              <label class="check"><input type="checkbox" name="keepScreenOn" ${s.keepScreenOn !== false ? 'checked' : ''} /> Keep screen on while recording</label>
            </fieldset>
            <button type="submit" class="hub-btn hub-btn--primary">Save settings</button>
            <button type="button" class="hub-btn" data-action="clear-session">Clear session</button>
          </form>
          ${logPanelHtml()}
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

    root.querySelector('[data-action="toggle-log"]')?.addEventListener('click', () => {
      logExpanded = !logExpanded;
      render();
    });

    root.querySelector('[data-action="start"]')?.addEventListener('click', async () => {
      const s = loadSettings();
      if (IS_NATIVE) {
        try {
          const p = await requestNativePermissions();
          if (p.notifications !== 'granted') {
            pushLog('Allow notifications for capsize alarms when the screen is off.');
          }
          if (p.location !== 'granted') {
            pushLog('Allow location (Always) for GPS while recording.');
          }
        } catch (e) {
          pushLog(`Permissions error: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
      }
      sessionStartedAt = Date.now();
      controlsCollapsed = true;
      speedAvg.clear();
      strokeRateAvg.clear();

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
      if (s.liveMapMode) {
        pushLog('Faster phone uploads on — GPS ~every 2.5 s (optional; uses more battery).');
        if (IS_NATIVE) void setNativeLiveMapMode(true);
      }
      const batchMs = s.enableMotion ? Math.max(s.uploadBatchMs, 8000) : s.uploadBatchMs;
      const syncInterval = s.liveMapMode
        ? 2000
        : Math.max(4000, Math.min(batchMs, 12000));
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
      speedAvg.clear();
      strokeRateAvg.clear();
      void exitStageFullscreen();
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

    root.querySelector('[data-action="toggle-fullscreen"]')?.addEventListener('click', async () => {
      const stage = root.querySelector('[data-session-stage]') as HTMLElement | null;
      if (!stage) return;
      try {
        if (document.fullscreenElement === stage) {
          await document.exitFullscreen();
        } else {
          await stage.requestFullscreen();
        }
      } catch {
        pushLog('Fullscreen not supported on this device.');
      }
    });

    root.querySelector('[data-action="connect-hr"]')?.addEventListener('click', () => {
      void controller?.connectHr();
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
  if (IS_KRI) {
    pushLog('KRI GPS ready. Set Device ID in Settings, then start a session.');
  } else {
    pushLog('RNZ Row Recorder ready. Set Device ID in Settings, then start a session.');
    if (IS_NATIVE) {
      void (async () => {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        try {
          const p = await requestNativePermissions();
          pushLog(
            `Permissions — notifications: ${p.notifications}, location: ${p.location}, accelerometer: ${p.accelerometer}`,
            false,
          );
          refreshLogPre();
        } catch (e) {
          pushLog(
            `Permission setup error: ${e instanceof Error ? e.message : String(e)}`,
            false,
          );
          refreshLogPre();
        }
      })();
    }
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}
