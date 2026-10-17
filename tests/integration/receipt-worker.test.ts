import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from '../../src/hooks.server';
import {
  closeDatabase,
  getRawDatabase,
} from '../../src/lib/server/db/connection';
import { migrateAndBootstrap } from '../../src/lib/server/db/lifecycle.js';
import { openSqliteDatabase } from '../../src/lib/server/db/sqlite.js';
import { createStubOcrEngine } from '../../src/lib/server/receipts/ocr-engine';
import {
  startReceiptWorker,
  stopReceiptWorker,
} from '../../src/lib/server/receipts/worker-loop';
import {
  INTERRUPTED_LAST_ERROR,
  claimNextPendingReceipt,
  retryReceipt,
  runReceiptWorkerTick,
  sweepOrphanedReceipts,
  type ReceiptWorkerOptions,
} from '../../src/lib/server/services/receipt-worker';
import { acceptReceiptUpload } from '../../src/lib/server/services/receipts';

type Database = ReturnType<typeof openSqliteDatabase>;
type Row = Record<string, unknown>;

const migrationsFolder = resolve(process.cwd(), 'migrations');
const fixturePath = resolve(
  process.cwd(),
  'tests/fixtures/receipts/stub-ocr.json',
);
const fixtureJson = readFileSync(fixturePath, 'utf8');

let directory: string;
let storageDir: string;
let database: Database;
let listId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'shopping-list-worker-'));
  storageDir = join(directory, 'receipts');
  mkdirSync(storageDir, { recursive: true });
  const databasePath = join(directory, 'shopping-list.sqlite');
  database = openSqliteDatabase(databasePath);
  migrateAndBootstrap(database, migrationsFolder);
  listId = (database.prepare('SELECT id FROM lists LIMIT 1').get() as Row)
    .id as string;

  process.env.CANONICAL_ORIGIN = 'http://localhost:5173';
  process.env.DATABASE_PATH = databasePath;
  process.env.RECEIPT_STORAGE_DIR = storageDir;
});

afterEach(() => {
  stopReceiptWorker();
  closeDatabase();
  database.close();
  rmSync(directory, { recursive: true, force: true });
  delete process.env.RECEIPT_OCR_URL;
  delete process.env.RECEIPT_OCR_MODE;
});

function insertReceipt(overrides: Record<string, unknown> = {}): string {
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO receipts
         (id, list_id, status, sha256, image_path, image_bytes, attempts,
          store_group_id, committed_at, last_error, created_at, updated_at)
       VALUES (@id, @listId, @status, @sha256, @imagePath, @imageBytes,
               @attempts, @storeGroupId, @committedAt, @lastError, @createdAt,
               @updatedAt)`,
    )
    .run({
      id,
      listId,
      status: 'pending',
      sha256: 'a'.repeat(64),
      imagePath: `${id}.jpg`,
      imageBytes: 0,
      attempts: 0,
      storeGroupId: null,
      committedAt: null,
      lastError: null,
      createdAt: '2026-10-17T12:00:00.000Z',
      updatedAt: '2026-10-17T12:00:00.000Z',
      ...overrides,
    });
  return id;
}

function writeImage(id: string, extension = 'jpg'): void {
  writeFileSync(join(storageDir, `${id}.${extension}`), 'fake-image-bytes');
}

function uploadRequest(): Request {
  const bytes = new Uint8Array(256);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  const body = new FormData();
  body.set('image', new Blob([bytes], { type: 'image/jpeg' }), 'receipt.jpg');
  return new Request('http://localhost:5173/api/receipts', {
    method: 'POST',
    body,
  });
}

function receiptRow(id: string): Row {
  return database
    .prepare(
      `SELECT status, attempts, ocr_json, last_error, processed_at, updated_at
         FROM receipts WHERE id = ?`,
    )
    .get(id) as Row;
}

function tick(options: ReceiptWorkerOptions = {}) {
  return runReceiptWorkerTick({
    database,
    storageDir,
    engine: createStubOcrEngine(),
    ...options,
  });
}

const failingEngine = {
  name: 'test-failure',
  extract: async () => {
    throw new Error('the sidecar is unreachable');
  },
};

describe('worker claim', () => {
  it('processes one pending receipt to review with its raw OCR payload stored', async () => {
    const id = insertReceipt();
    writeImage(id);

    const outcome = await tick();

    expect(outcome).toEqual({ outcome: 'processed', receiptId: id });
    const row = receiptRow(id);
    expect(row).toMatchObject({
      status: 'review',
      attempts: 1,
      ocr_json: fixtureJson,
      last_error: null,
    });
    expect(row.processed_at).toEqual(expect.any(String));
  });

  it('is idle when nothing is queued', async () => {
    expect(await tick()).toEqual({ outcome: 'idle' });
  });

  it('carries a freshly uploaded receipt to review in stub mode', async () => {
    process.env.RECEIPT_OCR_MODE = 'stub';
    process.env.RECEIPT_OCR_URL = 'http://stub.invalid/ocr';
    const uploaded = await acceptReceiptUpload(
      uploadRequest(),
      database,
      storageDir,
    );

    // No engine injected: the stub mode is chosen from the runtime config.
    const outcome = await runReceiptWorkerTick({ database, storageDir });

    expect(outcome).toEqual({
      outcome: 'processed',
      receiptId: uploaded.id,
    });
    expect(receiptRow(uploaded.id)).toMatchObject({
      status: 'review',
      attempts: 1,
      ocr_json: fixtureJson,
    });
    expect(receiptRow(uploaded.id).processed_at).toEqual(expect.any(String));
  });

  it('stays disabled while the feature is off', async () => {
    delete process.env.RECEIPT_OCR_URL;
    const id = insertReceipt();

    const outcome = await runReceiptWorkerTick({ database, storageDir });

    expect(outcome).toEqual({ outcome: 'disabled' });
    expect(receiptRow(id)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('claims one receipt per tick in creation order', async () => {
    const first = insertReceipt({ createdAt: '2026-10-17T12:00:00.000Z' });
    const second = insertReceipt({ createdAt: '2026-10-17T12:01:00.000Z' });
    writeImage(first);
    writeImage(second);

    expect(await tick()).toEqual({ outcome: 'processed', receiptId: first });
    expect(receiptRow(first)).toMatchObject({ status: 'review', attempts: 1 });
    expect(receiptRow(second)).toMatchObject({
      status: 'pending',
      attempts: 0,
    });

    expect(await tick()).toEqual({ outcome: 'processed', receiptId: second });
    expect(receiptRow(second)).toMatchObject({ status: 'review', attempts: 1 });

    expect(await tick()).toEqual({ outcome: 'idle' });
  });

  it('never double-processes when ticks overlap', async () => {
    const id = insertReceipt();
    writeImage(id);

    const outcomes = await Promise.all([tick(), tick(), tick()]);

    expect(outcomes.filter((o) => o.outcome === 'processed')).toEqual([
      { outcome: 'processed', receiptId: id },
    ]);
    expect(outcomes.filter((o) => o.outcome === 'idle')).toHaveLength(2);
    expect(receiptRow(id)).toMatchObject({ status: 'review', attempts: 1 });
  });

  it('only claims pending rows', () => {
    const review = insertReceipt({ status: 'review' });
    const failed = insertReceipt({ status: 'failed' });
    const discarded = insertReceipt({ status: 'discarded' });
    const pending = insertReceipt();

    expect(claimNextPendingReceipt(database)).toMatchObject({ id: pending });
    expect(claimNextPendingReceipt(database)).toBeUndefined();
    expect(receiptRow(review).status).toBe('review');
    expect(receiptRow(failed).status).toBe('failed');
    expect(receiptRow(discarded).status).toBe('discarded');
  });
});

describe('worker failure handling', () => {
  it('returns the receipt to pending until the attempt cap is spent, then fails it', async () => {
    const id = insertReceipt();
    writeImage(id);

    const first = await tick({ engine: failingEngine });
    expect(first).toMatchObject({
      outcome: 'retry-scheduled',
      receiptId: id,
      attempts: 1,
    });
    expect(receiptRow(id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_error: 'the sidecar is unreachable',
      processed_at: null,
    });

    const second = await tick({ engine: failingEngine });
    expect(second).toMatchObject({ outcome: 'retry-scheduled', attempts: 2 });
    expect(receiptRow(id)).toMatchObject({ status: 'pending', attempts: 2 });

    const third = await tick({ engine: failingEngine });
    expect(third).toMatchObject({ outcome: 'failed', attempts: 3 });
    expect(receiptRow(id)).toMatchObject({
      status: 'failed',
      attempts: 3,
      last_error: 'the sidecar is unreachable',
    });

    // The cap is 3: a failed receipt is not picked up again by the worker.
    expect(await tick({ engine: failingEngine })).toEqual({ outcome: 'idle' });
    expect(receiptRow(id)).toMatchObject({ status: 'failed', attempts: 3 });
  });

  it('recovers on a later attempt when the engine comes back', async () => {
    const id = insertReceipt();
    writeImage(id);

    await tick({ engine: failingEngine });
    expect(receiptRow(id)).toMatchObject({ status: 'pending', attempts: 1 });

    expect(await tick()).toEqual({ outcome: 'processed', receiptId: id });
    expect(receiptRow(id)).toMatchObject({
      status: 'review',
      attempts: 2,
      ocr_json: fixtureJson,
      last_error: null,
    });
  });

  it('treats a missing image as a retryable failure', async () => {
    const id = insertReceipt();

    expect(await tick()).toMatchObject({
      outcome: 'retry-scheduled',
      attempts: 1,
    });
    expect(receiptRow(id).last_error).toBe(
      'The receipt image is missing from storage.',
    );
  });

  it('honours a caller-supplied attempt cap', async () => {
    const id = insertReceipt();
    writeImage(id);

    expect(await tick({ engine: failingEngine, maxAttempts: 1 })).toMatchObject(
      {
        outcome: 'failed',
        attempts: 1,
      },
    );
    expect(receiptRow(id)).toMatchObject({ status: 'failed', attempts: 1 });
  });
});

describe('boot sweep', () => {
  it('returns an interrupted processing row to pending', () => {
    const id = insertReceipt({ status: 'processing', attempts: 1 });

    expect(sweepOrphanedReceipts(database)).toBe(1);
    expect(receiptRow(id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_error: null,
    });
  });

  it('fails an interrupted row that already spent the attempt cap', () => {
    const id = insertReceipt({ status: 'processing', attempts: 3 });

    expect(sweepOrphanedReceipts(database)).toBe(1);
    expect(receiptRow(id)).toMatchObject({
      status: 'failed',
      attempts: 3,
      last_error: INTERRUPTED_LAST_ERROR,
    });
  });

  it('keeps a reported error when failing an interrupted row', () => {
    const id = insertReceipt({
      status: 'processing',
      attempts: 3,
      lastError: 'the sidecar is unreachable',
    });

    sweepOrphanedReceipts(database);

    expect(receiptRow(id).last_error).toBe('the sidecar is unreachable');
  });

  it('honours a caller-supplied attempt cap', () => {
    const id = insertReceipt({ status: 'processing', attempts: 2 });

    sweepOrphanedReceipts(database, { maxAttempts: 2 });

    expect(receiptRow(id)).toMatchObject({ status: 'failed', attempts: 2 });
  });

  it('leaves every other status alone', () => {
    const pending = insertReceipt();
    const review = insertReceipt({ status: 'review' });
    const committedId = insertStoreReceipt();
    const failed = insertReceipt({ status: 'failed' });

    expect(sweepOrphanedReceipts(database)).toBe(0);
    expect(receiptRow(pending).status).toBe('pending');
    expect(receiptRow(review).status).toBe('review');
    expect(receiptRow(committedId).status).toBe('committed');
    expect(receiptRow(failed).status).toBe('failed');
  });
});

describe('manual retry', () => {
  it('resets a failed receipt to pending, keeping the previous error visible', () => {
    const id = insertReceipt({
      status: 'failed',
      attempts: 3,
      lastError: 'the sidecar is unreachable',
    });

    expect(retryReceipt(id, database)).toEqual({ id, status: 'pending' });
    expect(receiptRow(id)).toMatchObject({
      status: 'pending',
      attempts: 0,
      last_error: 'the sidecar is unreachable',
    });
  });

  it('re-queues the receipt for the worker', async () => {
    const id = insertReceipt({ status: 'failed', attempts: 3 });
    writeImage(id);

    retryReceipt(id, database);

    expect(await tick()).toEqual({ outcome: 'processed', receiptId: id });
    expect(receiptRow(id)).toMatchObject({ status: 'review', attempts: 1 });
  });

  it.each(['pending', 'processing', 'review', 'committed', 'discarded'])(
    'refuses to retry a %s receipt',
    (status) => {
      const id = insertReceipt({
        status,
        ...(status === 'committed'
          ? {
              storeGroupId: insertStoreGroup(),
              committedAt: '2026-10-17T12:00:00.000Z',
            }
          : {}),
      });

      expect(() => retryReceipt(id, database)).toThrowError(
        expect.objectContaining({ status: 409, code: 'INVALID_STATUS' }),
      );
      expect(receiptRow(id).status).toBe(status);
    },
  );

  it('reports an unknown receipt', () => {
    expect(() => retryReceipt(randomUUID(), database)).toThrowError(
      expect.objectContaining({ status: 404, code: 'NOT_FOUND' }),
    );
  });

  it('only reaches receipts in the current list', () => {
    const otherListId = randomUUID();
    database
      .prepare('INSERT INTO lists (id, name) VALUES (?, ?)')
      .run(otherListId, 'Other list');
    const id = randomUUID();
    database
      .prepare(
        `INSERT INTO receipts (id, list_id, status, sha256, attempts)
         VALUES (?, ?, 'failed', ?, 3)`,
      )
      .run(id, otherListId, 'b'.repeat(64));

    expect(() => retryReceipt(id, database)).toThrowError(
      expect.objectContaining({ status: 404 }),
    );
  });
});

describe('receipt worker loop', () => {
  /**
   * The loop works through the process-wide connection the app itself uses, so
   * these cases seed and read through `getRawDatabase()`.
   */
  function insertSharedReceipt(
    status: string,
    attempts: number,
    options: { withImage?: boolean } = {},
  ): string {
    const shared = getRawDatabase();
    const id = randomUUID();
    shared
      .prepare(
        `INSERT INTO receipts
           (id, list_id, status, sha256, attempts, image_path, image_bytes)
         VALUES (?, ?, ?, ?, ?, ?, 16)`,
      )
      .run(id, listId, status, 'c'.repeat(64), attempts, `${id}.jpg`);
    if (options.withImage) {
      writeFileSync(join(storageDir, `${id}.jpg`), 'fake-image-bytes');
    }
    return id;
  }

  it('does not start while the feature is off or sweep anything', () => {
    delete process.env.RECEIPT_OCR_URL;
    const shared = getRawDatabase();
    const id = insertSharedReceipt('processing', 1);

    expect(startReceiptWorker()).toBe(false);
    expect(
      shared.prepare('SELECT status FROM receipts WHERE id = ?').get(id),
    ).toEqual({ status: 'processing' });
  });

  it('sweeps interrupted rows at boot and keeps the loop running', () => {
    process.env.RECEIPT_OCR_MODE = 'stub';
    process.env.RECEIPT_OCR_URL = 'http://stub.invalid/ocr';
    const shared = getRawDatabase();
    const id = insertSharedReceipt('processing', 1);

    expect(startReceiptWorker()).toBe(true);
    expect(startReceiptWorker()).toBe(true);
    expect(
      shared
        .prepare('SELECT status, attempts FROM receipts WHERE id = ?')
        .get(id),
    ).toEqual({ status: 'pending', attempts: 1 });
  });

  it('drains the queue on its own tick', async () => {
    process.env.RECEIPT_OCR_MODE = 'stub';
    process.env.RECEIPT_OCR_URL = 'http://stub.invalid/ocr';
    const shared = getRawDatabase();
    const id = insertSharedReceipt('pending', 0, { withImage: true });

    expect(startReceiptWorker({ tickMs: 20 })).toBe(true);
    const row = await waitFor(() => {
      const candidate = shared
        .prepare(
          `SELECT status, attempts, ocr_json, processed_at
             FROM receipts WHERE id = ?`,
        )
        .get(id) as Row;
      return candidate.status === 'review' ? candidate : undefined;
    });

    expect(row).toMatchObject({
      status: 'review',
      attempts: 1,
      ocr_json: fixtureJson,
    });
    expect(row.processed_at).toEqual(expect.any(String));
  });

  it('sweeps interrupted rows through the server init hook', () => {
    process.env.RECEIPT_OCR_MODE = 'stub';
    process.env.RECEIPT_OCR_URL = 'http://stub.invalid/ocr';
    const shared = getRawDatabase();
    const id = insertSharedReceipt('processing', 1);

    init();

    expect(
      shared.prepare('SELECT status FROM receipts WHERE id = ?').get(id),
    ).toEqual({ status: 'pending' });
  });
});

async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the receipt worker.');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function insertStoreGroup(): string {
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO groups (id, list_id, name, normalized_name, kind, position)
       VALUES (?, ?, ?, ?, 'store', 0)`,
    )
    .run(id, listId, 'Corner Market', 'corner market');
  return id;
}

function insertStoreReceipt(): string {
  return insertReceipt({
    status: 'committed',
    storeGroupId: insertStoreGroup(),
    committedAt: '2026-10-17T12:00:00.000Z',
  });
}
