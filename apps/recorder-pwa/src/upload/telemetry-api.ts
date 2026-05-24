import type { IngestResponse, TelemetryBatch } from '@rowing/telemetry-types';

/** Stay under server limit (500) and avoid huge POST bodies on mobile networks. */
export const MAX_SAMPLES_PER_UPLOAD = 150;

const UPLOAD_TIMEOUT_MS = 45_000;
const IS_NATIVE = import.meta.env.VITE_PLATFORM === 'native';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeIngestUrl(url: string): string {
  const u = url.trim();
  if (!u) return u;
  try {
    const parsed = new URL(u);
    if (parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    }
    return parsed.toString();
  } catch {
    return u;
  }
}

function isRetryableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /failed to fetch|network|timeout|aborted|ECONNRESET|ETIMEDOUT/i.test(msg) ||
    /ingest failed (502|503|504|429)/i.test(msg)
  );
}

async function postOnceNative(
  ingestUrl: string,
  token: string,
  batch: TelemetryBatch,
): Promise<IngestResponse> {
  const { CapacitorHttp } = await import('@capacitor/core');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await CapacitorHttp.post({
    url: normalizeIngestUrl(ingestUrl),
    headers,
    data: batch,
    connectTimeout: UPLOAD_TIMEOUT_MS,
    readTimeout: UPLOAD_TIMEOUT_MS,
  });

  if (response.status < 200 || response.status >= 300) {
    const detail =
      typeof response.data === 'string'
        ? response.data
        : JSON.stringify(response.data ?? {});
    throw new Error(`Ingest failed ${response.status}: ${detail.slice(0, 200)}`);
  }

  if (response.data && typeof response.data === 'object') {
    return response.data as IngestResponse;
  }
  if (typeof response.data === 'string' && response.data.length) {
    return JSON.parse(response.data) as IngestResponse;
  }
  return { ok: true, received: batch.samples.length, sessionId: batch.sessionId };
}

async function postOnceFetch(
  ingestUrl: string,
  token: string,
  batch: TelemetryBatch,
): Promise<IngestResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const body = JSON.stringify(batch);
  const useKeepalive = !IS_NATIVE && body.length < 60_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(normalizeIngestUrl(ingestUrl), {
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
        : IS_NATIVE
          ? ' Native HTTP also failed — check mobile data/Wi‑Fi.'
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

async function postOnce(
  ingestUrl: string,
  token: string,
  batch: TelemetryBatch,
): Promise<IngestResponse> {
  if (IS_NATIVE) {
    try {
      return await postOnceNative(ingestUrl, token, batch);
    } catch (nativeErr) {
      try {
        return await postOnceFetch(ingestUrl, token, batch);
      } catch {
        throw nativeErr;
      }
    }
  }
  return postOnceFetch(ingestUrl, token, batch);
}

/** POST a batch, splitting samples into safe-sized chunks. */
export async function postTelemetryBatch(
  ingestUrl: string,
  token: string,
  batch: TelemetryBatch,
): Promise<IngestResponse> {
  const url = normalizeIngestUrl(ingestUrl);
  const samples = batch.samples;
  if (samples.length <= MAX_SAMPLES_PER_UPLOAD) {
    return postOnceWithRetry(url, token, batch);
  }

  let last: IngestResponse = { ok: true, sessionId: batch.sessionId, received: 0 };
  for (let i = 0; i < samples.length; i += MAX_SAMPLES_PER_UPLOAD) {
    const chunk = samples.slice(i, i + MAX_SAMPLES_PER_UPLOAD);
    last = await postOnceWithRetry(url, token, { ...batch, samples: chunk });
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

/** Minimal POST for Settings connectivity test. */
export async function testIngestConnection(
  ingestUrl: string,
  token: string,
  deviceId: string,
): Promise<string> {
  const id = deviceId.trim() || 'connectivity-test';
  const batch: TelemetryBatch = {
    sessionId: crypto.randomUUID(),
    deviceId: id,
    samples: [{ t: Date.now(), gps: { lat: -37.93, lon: 175.55 } }],
  };
  const res = await postTelemetryBatch(ingestUrl, token, batch);
  return `OK — server received ${res.received ?? 1} sample(s)`;
}
