import type { RecorderSettings, TelemetryBatch } from '@rowing/telemetry-types';
import {
  listPendingOutbox,
  markOutboxSent,
} from '../session/store';
import { postTelemetryBatch } from './telemetry-api';
import { sendOsmAndPosition } from './traccar';

export async function flushOutbox(settings: RecorderSettings): Promise<{
  sent: number;
  failed: number;
}> {
  const rows = await listPendingOutbox(40);
  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    if (!row.id) continue;
    try {
      if (row.kind === 'traccar') {
        const ok = await sendOsmAndPosition(row.payload);
        if (!ok) {
          failed++;
          continue;
        }
      } else {
        const parsed = JSON.parse(row.payload) as {
          sessionId: string;
          samples: TelemetryBatch['samples'];
        };
        await postTelemetryBatch(settings.ingestUrl, settings.ingestToken, {
          sessionId: parsed.sessionId,
          deviceId: settings.deviceId,
          athleteId: settings.athleteId || undefined,
          samples: parsed.samples,
        });
      }
      await markOutboxSent(row.id);
      sent++;
    } catch {
      failed++;
    }
  }

  return { sent, failed };
}
