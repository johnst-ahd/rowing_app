import type { IngestResponse, TelemetryBatch } from '@rowing/telemetry-types';

export async function postTelemetryBatch(
  ingestUrl: string,
  token: string,
  batch: TelemetryBatch,
): Promise<IngestResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(ingestUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(batch),
    keepalive: true,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ingest failed ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json() as Promise<IngestResponse>;
}
