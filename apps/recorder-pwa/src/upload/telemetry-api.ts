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

  let res: Response;
  try {
    res = await fetch(ingestUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(batch),
      keepalive: true,
    });
  } catch (e) {
    const hint =
      ingestUrl.includes('localhost') || ingestUrl.includes('127.0.0.1')
        ? ' Ingest URL points at localhost — open Settings and set the Vercel ingest URL.'
        : '';
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to fetch (${msg}).${hint}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ingest failed ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json() as Promise<IngestResponse>;
}
