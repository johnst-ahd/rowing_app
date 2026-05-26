import { CapacitorAccelerometer } from '@capgo/capacitor-accelerometer';
import { Geolocation } from '@capacitor/geolocation';
import { LocalNotifications } from '@capacitor/local-notifications';

export type NativePermissionStatus = {
  location: string;
  notifications: string;
  accelerometer: string;
};

function permLabel(
  state: string | undefined,
): string {
  if (!state || state === 'granted') return 'granted';
  if (state === 'denied') return 'denied';
  if (state === 'prompt' || state === 'prompt-with-rationale') return 'not asked yet';
  return state;
}

/** Notifications, location, and accelerometer (native sensor). Notifications first so Android shows the prompt before GPS. */
export async function requestNativePermissions(): Promise<NativePermissionStatus> {
  const status: NativePermissionStatus = {
    location: 'unknown',
    notifications: 'unknown',
    accelerometer: 'unknown',
  };

  try {
    const notif = await LocalNotifications.checkPermissions();
    if (notif.display !== 'granted') {
      const req = await LocalNotifications.requestPermissions();
      status.notifications = permLabel(req.display);
    } else {
      status.notifications = 'granted';
    }
  } catch {
    status.notifications = 'error';
  }

  try {
    const loc = await Geolocation.requestPermissions({
      permissions: ['location', 'coarseLocation'],
    });
    status.location = permLabel(loc.location ?? loc.coarseLocation);
  } catch {
    status.location = 'error';
  }

  try {
    const avail = await CapacitorAccelerometer.isAvailable();
    if (!avail.isAvailable) {
      status.accelerometer = 'unavailable';
    } else {
      const accel = await CapacitorAccelerometer.requestPermissions();
      status.accelerometer = permLabel(accel.accelerometer);
    }
  } catch {
    status.accelerometer = 'error';
  }

  return status;
}
