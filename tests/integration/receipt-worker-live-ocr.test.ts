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
import { migrateAndBootstrap } from '../../src/lib/server/db/lifecycle.js';
import { openSqliteDatabase } from '../../src/lib/server/db/sqlite.js';
import { createHttpOcrEngine } from '../../src/lib/server/receipts/ocr-engine';
import { runReceiptWorkerTick } from '../../src/lib/server/services/receipt-worker';

/**
 * The end-to-end seam, against a real OCR engine: seed the queue the way an
 * upload does, let the worker POST the bytes to the sidecar, and expect a
 * `review` receipt carrying the engine's own JSON.
 *
 * Skipped by default. Start the sidecar (dev compose profile, or the published
 * image) and point the suite at it:
 *
 *   RECEIPT_LIVE_OCR_URL=http://127.0.0.1:8060/ocr \
 *   RECEIPT_LIVE_OCR_TOKEN=… (only when the sidecar requires one) \
 *   pnpm exec vitest run tests/integration/receipt-worker-live-ocr.test.ts
 */

const sidecarUrl = process.env.RECEIPT_LIVE_OCR_URL;
const sidecarToken = process.env.RECEIPT_LIVE_OCR_TOKEN;
const fixturePath = resolve(
  process.cwd(),
  'ocr-sidecar/tests/fixtures/sample-receipt.png',
);

let directory: string;
let storageDir: string;
let database: ReturnType<typeof openSqliteDatabase>;
let listId: string;

describe.skipIf(!sidecarUrl)('worker against a live OCR sidecar', () => {
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'shopping-list-live-ocr-'));
    storageDir = join(directory, 'receipts');
    mkdirSync(storageDir, { recursive: true });
    database = openSqliteDatabase(join(directory, 'shopping-list.sqlite'));
    migrateAndBootstrap(database, resolve(process.cwd(), 'migrations'));
    listId = (
      database.prepare('SELECT id FROM lists LIMIT 1').get() as { id: string }
    ).id;
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('moves an uploaded receipt to review with real ocr_json', async () => {
    const image = readFileSync(fixturePath);
    const id = randomUUID();
    database
      .prepare(
        `INSERT INTO receipts
           (id, list_id, status, sha256, image_path, image_bytes)
         VALUES (?, ?, 'pending', ?, ?, ?)`,
      )
      .run(id, listId, 'b'.repeat(64), `${id}.png`, image.byteLength);
    writeFileSync(join(storageDir, `${id}.png`), image);

    const outcome = await runReceiptWorkerTick({
      database,
      storageDir,
      engine: createHttpOcrEngine({
        url: sidecarUrl as string,
        token: sidecarToken,
        timeoutMs: 60_000,
      }),
    });

    expect(outcome).toEqual({ outcome: 'processed', receiptId: id });
    const row = database
      .prepare(
        'SELECT status, attempts, ocr_json, last_error, processed_at FROM receipts WHERE id = ?',
      )
      .get(id) as {
      status: string;
      attempts: number;
      ocr_json: string;
      last_error: string | null;
      processed_at: string | null;
    };
    expect(row.status).toBe('review');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBeNull();
    expect(row.processed_at).not.toBeNull();

    const payload = JSON.parse(row.ocr_json) as {
      pages: { lines: { box: number[]; text: string; conf: number }[] }[];
      engine: { name: string };
    };
    expect(payload.engine.name).toBe('indra-ocr');
    expect(payload.pages[0].lines.length).toBeGreaterThan(0);
    expect(
      payload.pages[0].lines.some((line) => line.text.includes('2.99')),
    ).toBe(true);
  });
});
