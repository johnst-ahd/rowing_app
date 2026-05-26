import './styles.css';
import { DEFAULT_SETTINGS } from '@rowing/telemetry-types';
import { loadSettings, saveSettings } from '../../apps/recorder-pwa/src/lib/settings';
import { mountApp } from '../../apps/recorder-pwa/src/ui/app';

function enforceKriProfile(): void {
  const s = loadSettings();
  s.enableGps = true;
  s.enableMotion = true;
  s.enableHr = false;
  s.deviceId = s.deviceId || DEFAULT_SETTINGS.deviceId;
  saveSettings(s);
}

function applyKriBranding(root: HTMLElement): void {
  const update = () => {
    const footerLine = root.querySelector('.ahd-footer__line');
    if (footerLine) {
      footerLine.textContent = 'KRI Safety System · KRI GPS';
    }

    const firstHint = root.querySelector('.hub-panel .hint');
    if (firstHint && firstHint.textContent?.includes('stroke rate')) {
      firstHint.textContent =
        'Set a Device ID in Settings, then start a session. Live timer, capsize status, and pace appear at the top while recording.';
    }

    const sensorsHint = root.querySelector('.hub-panel.toggles-hint .hint');
    if (sensorsHint) {
      sensorsHint.textContent = sensorsHint.textContent?.replace(' · HR on', '')?.replace(' · HR off', '') ?? '';
    }
  };

  const obs = new MutationObserver(update);
  obs.observe(root, { childList: true, subtree: true });
  update();
}

function showBootError(root: HTMLElement, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  root.innerHTML = `
    <section class="hub-panel" style="margin:1rem">
      <h2>KRI GPS failed to start</h2>
      <p class="hint">${msg.replace(/</g, '&lt;')}</p>
      <p class="hint">Try reinstalling the latest APK from the install page.</p>
    </section>
  `;
}

const root = document.getElementById('app');
if (!root) throw new Error('#app not found');

window.addEventListener('error', (ev) => {
  if (root.querySelector('.ahd-recorder-shell')) return;
  showBootError(root, ev.error ?? ev.message);
});
window.addEventListener('unhandledrejection', (ev) => {
  if (root.querySelector('.ahd-recorder-shell')) return;
  showBootError(root, ev.reason);
});

try {
  enforceKriProfile();
  mountApp(root);
  applyKriBranding(root);
} catch (err) {
  showBootError(root, err);
}
