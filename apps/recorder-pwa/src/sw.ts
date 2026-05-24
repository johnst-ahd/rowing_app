/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

const DB_NAME = 'rnz-recorder';
const SYNC_TAG = 'rnz-upload-outbox';

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener('sync', (event: Event) => {
  const e = event as Event & { tag: string; waitUntil: (p: Promise<unknown>) => void };
  if (e.tag === SYNC_TAG) {
    e.waitUntil(flushOutboxFromSw());
  }
});

type OutboxRow = {
  id?: number;
  sessionId: string;
  payload: string;
  kind: string;
  sent: number;
};

type UploadConfig = {
  deviceId: string;
  athleteId: string;
  ingestUrl: string;
  ingestToken: string;
};

async function flushOutboxFromSw(): Promise<void> {
  const config = await idbGet<UploadConfig & { id: string }>('uploadConfig', 'active');
  if (!config?.ingestUrl) return;

  const rows = await listPendingOutbox(20);
  for (const row of rows) {
    if (!row.id || row.kind !== 'telemetry') continue;
    try {
      const parsed = JSON.parse(row.payload) as {
        sessionId: string;
        samples: unknown[];
      };
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (config.ingestToken) {
        headers.Authorization = `Bearer ${config.ingestToken}`;
      }
      const res = await fetch(config.ingestUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sessionId: parsed.sessionId,
          deviceId: config.deviceId,
          athleteId: config.athleteId || undefined,
          samples: parsed.samples,
        }),
      });
      if (!res.ok) continue;
      await markOutboxSent(row.id);
    } catch {
      /* retry on next sync */
    }
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

async function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function listPendingOutbox(limit: number): Promise<OutboxRow[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const rows: OutboxRow[] = [];
    const tx = db.transaction('outbox', 'readonly');
    const req = tx.objectStore('outbox').openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(rows.slice(0, limit));
        return;
      }
      const row = cursor.value as OutboxRow;
      if (!row.sent) rows.push(row);
      if (rows.length >= limit) {
        resolve(rows);
        return;
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

async function markOutboxSent(id: number): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('outbox', 'readwrite');
    const store = tx.objectStore('outbox');
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const row = getReq.result as OutboxRow | undefined;
      if (!row) {
        resolve();
        return;
      }
      row.sent = 1;
      store.put(row);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
