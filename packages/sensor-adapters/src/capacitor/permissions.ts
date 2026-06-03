import { Capacitor, registerPlugin } from '@capacitor/core';
import { CapacitorAccelerometer } from '@capgo/capacitor-accelerometer';
import { Geolocation } from '@capacitor/geolocation';
import { LocalNotifications } from '@capacitor/local-notifications';

type AndroidRecordingSetup = {
  ready: boolean;
  notifications: boolean;
  locationForeground: boolean;
  locationBackground: boolean;
  locationAlways: boolean;
  batteryUnrestricted: boolean;
  openedLocationSettings?: boolean;
  openedBatterySettings?: boolean;
};

const CapsizeMonitorAndroid = registerPlugin<{
  prepareRecording: () => Promise<AndroidRecordingSetup>;
}>('CapsizeMonitor');

const CAPSIZE_CHANNEL_ID = 'rnz-capsize';
let capsizeChannelReady = false;

async function ensureCapsizeNotificationChannel(): Promise<void> {
  if (capsizeChannelReady) return;
  try {
    await LocalNotifications.createChannel({
      id: CAPSIZE_CHANNEL_ID,
      name: 'Capsize alerts',
      description: 'Urgent capsize alarms while recording',
      importance: 5,
      visibility: 1,
      vibration: true,
      sound: 'default',
    });
    capsizeChannelReady = true;
  } catch {
    /* channel may already exist */
  }
}

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

export type NativePermissionResult = NativePermissionStatus & {
  recordingSetup?: AndroidRecordingSetup;
};

export type { AndroidRecordingSetup };

/** Notifications, location, and accelerometer (native sensor). Notifications first so Android shows the prompt before GPS. */
export async function requestNativePermissions(): Promise<NativePermissionResult> {
  const status: NativePermissionResult = {
    location: 'unknown',
    notifications: 'unknown',
    accelerometer: 'unknown',
  };

  if (Capacitor.getPlatform() === 'android') {
    try {
      const setup = await CapsizeMonitorAndroid.prepareRecording();
      status.recordingSetup = setup;
      status.notifications = setup.notifications ? 'granted' : 'denied';
      status.location = setup.locationAlways
        ? 'granted'
        : setup.locationForeground
          ? 'foreground only'
          : 'denied';
      status.accelerometer = 'granted';
      return status;
    } catch {
      /* fall through to Capacitor prompts */
    }
  }

  try {
    const notif = await LocalNotifications.checkPermissions();
    if (notif.display !== 'granted') {
      const req = await LocalNotifications.requestPermissions();
      status.notifications = permLabel(req.display);
    } else {
      status.notifications = 'granted';
    }
    if (status.notifications === 'granted') {
      await ensureCapsizeNotificationChannel();
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
    } else if (Capacitor.getPlatform() === 'android') {
      /* Avoid requestPermissions() here — can crash WebView on some Samsung builds. */
      status.accelerometer = 'granted';
    } else {
      const accel = await CapacitorAccelerometer.requestPermissions();
      status.accelerometer = permLabel(accel.accelerometer);
    }
  } catch {
    status.accelerometer = 'error';
  }

  return status;
}
