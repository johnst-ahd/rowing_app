import type { IngestResponse, TelemetryBatch } from '@rowing/telemetry-types';

/** Stay under server limit (500) and avoid huge POST bodies on mobile networks. */
export const MAX_SAMPLES_PER_UPLOAD = 150;

const UPLOAD_TIMEOUT_MS = 45_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /failed to fetch|network|timeout|aborted|ECONNRESET|ETIMEDOUT/i.test(msg) ||
    /ingest failed (502|503|504|429)/i.test(msg)
  );
}

async function postOnce(
  ingestUrl: string,
  token: string,
  batch: TelemetryBatch,
): Promise<IngestResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const body = JSON.stringify(batch);
  const useKeepalive =
    import.meta.env.VITE_PLATFORM !== 'native' && body.length < 60_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(ingestUrl, {
      method: 'POST',
      headers,
      body,
      keepalive: useKeepalive,
      signal: controller.signal,
    });
  } catch (e) {
    const hint =
      ingestUrl.includes('localhost') || ingestUrl.includes('127.0.0.1')
        ? ' Ingest URL points at localhost — open Settings and set the Vercel ingest URL.'
        : '';
    const msg = e instanceof Error ? e.message : String(e);
    const aborted = e instanceof Error && e.name === 'AbortError';
    throw new Error(
      aborted
        ? `Upload timed out after ${UPLOAD_TIMEOUT_MS / 1000}s.${hint}`
        : `Failed to fetch (${msg}).${hint}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ingest failed ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json() as Promise<IngestResponse>;
}

/** POST a batch, splitting samples into safe-sized chunks. */
export async function postTelemetryBatch(
  ingestUrl: string,
  token: string,
  batch: TelemetryBatch,
): Promise<IngestResponse> {
  const samples = batch.samples;
  if (samples.length <= MAX_SAMPLES_PER_UPLOAD) {
    return postOnceWithRetry(ingestUrl, token, batch);
  }

  let last: IngestResponse = { ok: true, sessionId: batch.sessionId, received: 0 };
  for (let i = 0; i < samples.length; i += MAX_SAMPLES_PER_UPLOAD) {
    const chunk = samples.slice(i, i + MAX_SAMPLES_PER_UPLOAD);
    last = await postOnceWithRetry(ingestUrl, token, { ...batch, samples: chunk });
  }
  return last;
}

async function postOnceWithRetry(
  ingestUrl: string,
  token: string,
  batch: TelemetryBatch,
): Promise<IngestResponse> {
  const delays = [0, 1200, 3500];
  let lastErr: unknown;
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    try {
      return await postOnce(ingestUrl, token, batch);
    } catch (e) {
      lastErr = e;
      if (!isRetryableError(e)) throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
