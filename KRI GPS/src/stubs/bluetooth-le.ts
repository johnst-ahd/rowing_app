/** KRI build stub — no Bluetooth / heart rate. */
export const BleClient = {
  initialize: async () => {},
  requestDevice: async () => {
    throw new Error('Bluetooth not available in KRI GPS');
  },
  connect: async () => {},
  disconnect: async () => {},
  startNotifications: async () => {},
  stopNotifications: async () => {},
};

export function numberToUUID(n: number): string {
  return `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
}
