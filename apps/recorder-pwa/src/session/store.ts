import type { SessionMeta, TelemetrySample } from '@rowing/telemetry-types';

const DB_NAME = 'rnz-recorder';
const DB_VERSION = 1;

export type OutboxRow = {
  id?: number;
  sessionId: string;
  createdAt: number;
  payload: string;
  kind: 'telemetry' | 'traccar';
  sent: number;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('outbox')) {
        const outbox = db.createObjectStore('outbox', {
          keyPath: 'id',
          autoIncrement: true,
        });
        outbox.createIndex('sent', 'sent', { unique: false });
        outbox.createIndex('sessionId', 'sessionId', { unique: false });
      }
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'sessionId' });
      }
    };
  });
}

export async function saveSession(meta: SessionMeta): Promise<void> {
  const db = await openDb();
  await idbPut(db, 'sessions', meta);
}

export async function getSession(sessionId: string): Promise<SessionMeta | undefined> {
  const db = await openDb();
  return idbGet(db, 'sessions', sessionId);
}

export async function enqueueOutbox(
  row: Omit<OutboxRow, 'id' | 'sent' | 'createdAt'>,
): Promise<void> {
  const db = await openDb();
  await idbAdd(db, 'outbox', {
    ...row,
    createdAt: Date.now(),
    sent: 0,
  });
}

export async function enqueueTelemetry(
  sessionId: string,
  samples: TelemetrySample[],
): Promise<void> {
  if (samples.length === 0) return;
  await enqueueOutbox({
    sessionId,
    kind: 'telemetry',
    payload: JSON.stringify({ sessionId, samples }),
  });
}

export async function enqueueTraccar(
  sessionId: string,
  url: string,
): Promise<void> {
  await enqueueOutbox({
    sessionId,
    kind: 'traccar',
    payload: url,
  });
}

export async function listPendingOutbox(limit = 50): Promise<OutboxRow[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const rows: OutboxRow[] = [];
    const tx = db.transaction('outbox', 'readonly');
    const store = tx.objectStore('outbox');
    const req = store.openCursor();
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

export async function markOutboxSent(id: number): Promise<void> {
  const db = await openDb();
  const row = await idbGet<OutboxRow>(db, 'outbox', id);
  if (row) {
    row.sent = 1;
    await idbPut(db, 'outbox', row);
  }
}

export async function countPendingOutbox(): Promise<number> {
  const pending = await listPendingOutbox(9999);
  return pending.length;
}

function idbGet<T>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(value);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbAdd(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).add(value);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
