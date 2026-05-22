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
  errors: string[];
}> {
  const rows = await listPendingOutbox(40);
  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const row of rows) {
    if (!row.id) continue;
    try {
      if (row.kind === 'traccar') {
        const result = await sendOsmAndPosition(row.payload);
        if (!result.ok) {
          failed++;
          errors.push(`Traccar: ${result.error || 'failed'}`);
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
    } catch (e) {
      failed++;
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  return { sent, failed, errors };
}
