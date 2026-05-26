import { LocalNotifications } from '@capacitor/local-notifications';

const IS_NATIVE = import.meta.env.VITE_PLATFORM === 'native';
const CHANNEL_ID = 'rnz-capsize';
const NOTIF_ID = 9001;
/** Re-alert while still capsized and app is backgrounded. */
const REPEAT_MS = 45_000;

let channelReady = false;
let lastAlertAt = 0;

export async function ensureCapsizeAlertReady(): Promise<boolean> {
  if (!IS_NATIVE) return false;
  try {
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') {
      const req = await LocalNotifications.requestPermissions();
      if (req.display !== 'granted') return false;
    }
    if (!channelReady) {
      await LocalNotifications.createChannel({
        id: CHANNEL_ID,
        name: 'Capsize alerts',
        description: 'Urgent capsize alarms while recording',
        importance: 5,
        visibility: 1,
        vibration: true,
        sound: 'default',
      });
      channelReady = true;
    }
    return true;
  } catch {
    return false;
  }
}

/** System notification + sound (works when screen off / app minimized). */
export async function showCapsizeAlertNotification(force = false): Promise<void> {
  if (!IS_NATIVE) return;
  const now = Date.now();
  if (!force && now - lastAlertAt < REPEAT_MS) return;
  const ready = await ensureCapsizeAlertReady();
  if (!ready) return;
  lastAlertAt = now;
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id: NOTIF_ID,
          title: 'CAPSIZE ALERT',
          body: 'Boat tipped past horizontal — check crew immediately',
          channelId: CHANNEL_ID,
          sound: 'default',
          smallIcon: 'ic_stat_rnz_alert',
          iconColor: '#DC2626',
          priority: 4,
          autoCancel: true,
          extra: { type: 'capsize' },
        },
      ],
    });
  } catch (e) {
    console.warn('Capsize notification failed', e);
  }
}

export async function clearCapsizeAlertNotification(): Promise<void> {
  if (!IS_NATIVE) return;
  lastAlertAt = 0;
  try {
    await LocalNotifications.cancel({ notifications: [{ id: NOTIF_ID }] });
  } catch {
    /* optional */
  }
}
