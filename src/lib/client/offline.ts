import { snapshotSchema, type Snapshot } from '../shared/schemas';

const DATABASE_NAME = 'shopping-list-offline';
const DATABASE_VERSION = 1;
const STORE_NAME = 'snapshot';
const SNAPSHOT_KEY = 'current-list';
const SERVICE_WORKER_CACHE_PREFIX = 'shopping-list-shell-';

interface StoredSnapshot {
  schemaVersion: 1;
  snapshot: Snapshot;
  lastVerifiedAt: number;
}

export interface OfflineSnapshot {
  snapshot: Snapshot | null;
  lastVerifiedAt: number | null;
  incompatible: boolean;
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(
      new Error('IndexedDB is unavailable in this browser.'),
    );
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () =>
      reject(request.error ?? new Error('Could not open offline storage.'));
    request.onblocked = () =>
      reject(new Error('Offline storage is blocked by another tab.'));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        transaction.error ?? new Error('Offline storage transaction failed.'),
      );
    transaction.onabort = () =>
      reject(
        transaction.error ??
          new Error('Offline storage transaction was cancelled.'),
      );
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('Could not read offline storage.'));
  });
}

export async function loadOfflineSnapshot(): Promise<OfflineSnapshot> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const done = transactionComplete(transaction);
    const store = transaction.objectStore(STORE_NAME);
    const stored = await requestResult<unknown>(store.get(SNAPSHOT_KEY));
    if (!stored || typeof stored !== 'object') {
      await done;
      return { snapshot: null, lastVerifiedAt: null, incompatible: false };
    }

    const record = stored as Partial<StoredSnapshot>;
    const parsed =
      record.schemaVersion === 1
        ? snapshotSchema.safeParse(record.snapshot)
        : null;
    if (
      !parsed ||
      !parsed.success ||
      typeof record.lastVerifiedAt !== 'number' ||
      !Number.isFinite(record.lastVerifiedAt)
    ) {
      store.delete(SNAPSHOT_KEY);
      await done;
      return { snapshot: null, lastVerifiedAt: null, incompatible: true };
    }

    await done;
    return {
      snapshot: parsed.data,
      lastVerifiedAt: record.lastVerifiedAt,
      incompatible: false,
    };
  } finally {
    database.close();
  }
}

export async function saveOfflineSnapshot(
  snapshot: Snapshot,
  lastVerifiedAt: number,
): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const done = transactionComplete(transaction);
    const record: StoredSnapshot = {
      schemaVersion: 1,
      snapshot,
      lastVerifiedAt,
    };
    transaction.objectStore(STORE_NAME).put(record, SNAPSHOT_KEY);
    await done;
  } finally {
    database.close();
  }
}

/** Remove only this app's local snapshot and shell caches, never server data. */
export async function clearOfflineData(): Promise<void> {
  const failures: unknown[] = [];
  try {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const done = transactionComplete(transaction);
      transaction.objectStore(STORE_NAME).delete(SNAPSHOT_KEY);
      await done;
    } finally {
      database.close();
    }
  } catch (error) {
    failures.push(error);
  }

  try {
    if ('caches' in globalThis) {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => name.startsWith(SERVICE_WORKER_CACHE_PREFIX))
          .map((name) => caches.delete(name)),
      );
    }
  } catch (error) {
    failures.push(error);
  }

  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(
        registrations
          .filter((registration) => {
            const worker =
              registration.active ??
              registration.waiting ??
              registration.installing;
            return worker?.scriptURL.endsWith('/service-worker.js') ?? false;
          })
          .map((registration) => registration.unregister()),
      );
    }
  } catch (error) {
    failures.push(error);
  }

  if (failures.length > 0) {
    throw new Error('Some saved data could not be cleared from this device.');
  }
}
