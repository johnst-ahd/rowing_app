import type { RecorderSettings, TelemetryBatch } from '@rowing/telemetry-types';
import {
  listPendingOutbox,
  markOutboxSent,
} from '../session/store';
import { postTelemetryBatch } from './telemetry-api';

let flushInFlight: Promise<{
  sent: number;
  failed: number;
  errors: string[];
}> | null = null;

async function flushOutboxInner(settings: RecorderSettings): Promise<{
  sent: number;
  failed: number;
  errors: string[];
}> {
  const rows = await listPendingOutbox(25);
  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const row of rows) {
    if (!row.id) continue;
    try {
      if (row.kind === 'traccar') {
        await markOutboxSent(row.id);
        sent++;
        continue;
      }

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
      await markOutboxSent(row.id);
      sent++;
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(msg);
      // Stop this cycle on hard errors so we do not hammer a bad URL/token.
      if (/401|403|413|localhost/i.test(msg)) break;
    }
  }

  return { sent, failed, errors };
}

export async function flushOutbox(settings: RecorderSettings): Promise<{
  sent: number;
  failed: number;
  errors: string[];
}> {
  if (flushInFlight) return flushInFlight;
  flushInFlight = flushOutboxInner(settings).finally(() => {
    flushInFlight = null;
  });
  return flushInFlight;
}
