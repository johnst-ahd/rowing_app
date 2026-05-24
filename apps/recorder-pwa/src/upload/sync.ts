import type { RecorderSettings, TelemetryBatch } from '@rowing/telemetry-types';
import {
  listPendingOutbox,
  markOutboxSent,
  repairOversizedPendingOutbox,
} from '../session/store';
import { MAX_SAMPLES_PER_UPLOAD, postTelemetryBatch } from './telemetry-api';

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
  const repaired = await repairOversizedPendingOutbox(MAX_SAMPLES_PER_UPLOAD);
  const rows = await listPendingOutbox(40);
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
      const sampleCount = parsed.samples?.length ?? 0;
      if (sampleCount === 0) {
        await markOutboxSent(row.id);
        sent++;
        continue;
      }

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
      const parsed = safeParsePayload(row.payload);
      const n = parsed?.samples?.length ?? '?';
      errors.push(`batch (${n} samples): ${msg}`);
      // Only stop the cycle for auth / config errors — keep draining other rows.
      if (/401|403|localhost/i.test(msg)) break;
    }
  }

  if (repaired > 0 && errors.length === 0 && sent === 0 && failed === 0) {
    errors.push(`Split ${repaired} oversized queue batch(es) — retrying…`);
  }

  return { sent, failed, errors };
}

function safeParsePayload(payload: string): { samples?: TelemetryBatch['samples'] } | null {
  try {
    return JSON.parse(payload) as { samples?: TelemetryBatch['samples'] };
  } catch {
    return null;
  }
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
