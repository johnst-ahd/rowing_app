/** @param {object} row */
function normalizeRegattaMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    deviceId: String(row.device_id ?? row.deviceId ?? ''),
    text: String(row.text ?? ''),
    createdAt: row.created_at ?? row.createdAt ?? null,
  };
}

const MAX_TEXT_LEN = 280;

function validateMessageBody(body) {
  const text = String(body?.text ?? '').trim();
  if (!text) throw new Error('Message text is required');
  if (text.length > MAX_TEXT_LEN) {
    throw new Error(`Message must be ${MAX_TEXT_LEN} characters or fewer`);
  }

  const deviceId = String(body?.deviceId ?? '').trim();
  const allDevices = body?.allDevices === true || deviceId === '*';
  if (allDevices) {
    const deviceIds = Array.isArray(body?.deviceIds)
      ? [...new Set(body.deviceIds.map((id) => String(id ?? '').trim()).filter(Boolean))]
      : null;
    return { allDevices: true, text, deviceIds };
  }

  if (!deviceId) throw new Error('deviceId is required');
  return { deviceId, text };
}

module.exports = {
  normalizeRegattaMessage,
  validateMessageBody,
  MAX_TEXT_LEN,
};
