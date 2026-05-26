import type { HeartRateMonitor, HrReading } from '../types';

function parseHr(data: DataView): HrReading {
  const flags = data.getUint8(0);
  const rate16 = (flags & 0x1) === 0x1;
  const contact = (flags & 0x2) === 0x2;
  const contactSupported = (flags & 0x4) === 0x4;
  const bpm = rate16 ? data.getUint16(1, true) : data.getUint8(1);
  return {
    bpm,
    contact: contactSupported ? contact : undefined,
    t: Date.now(),
  };
}

let bleInitialized = false;

export async function connectHeartRate(
  onReading: (r: HrReading) => void,
  onError?: (msg: string) => void,
): Promise<HeartRateMonitor | null> {
  try {
    const { BleClient, numberToUUID } = await import('@capacitor-community/bluetooth-le');
    const HR_SERVICE = numberToUUID(0x180d);
    const HR_MEASUREMENT = numberToUUID(0x2a37);

    if (!bleInitialized) {
      await BleClient.initialize({ androidNeverForLocation: false });
      bleInitialized = true;
    }

    const device = await BleClient.requestDevice({
      services: [HR_SERVICE],
      optionalServices: [HR_SERVICE],
    });

    await BleClient.connect(device.deviceId, () => {
      onError?.('Heart rate monitor disconnected');
    });

    await BleClient.startNotifications(
      device.deviceId,
      HR_SERVICE,
      HR_MEASUREMENT,
      (value) => {
        onReading(parseHr(value));
      },
    );

    return {
      name: device.name || 'HR monitor',
      disconnect: async () => {
        try {
          await BleClient.stopNotifications(device.deviceId, HR_SERVICE, HR_MEASUREMENT);
        } catch {
          /* ignore */
        }
        try {
          await BleClient.disconnect(device.deviceId);
        } catch {
          /* ignore */
        }
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.toLowerCase().includes('cancel')) onError?.(msg);
    return null;
  }
}
