import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateAndBootstrap } from '../../src/lib/server/db/lifecycle.js';
import { openSqliteDatabase } from '../../src/lib/server/db/sqlite.js';
import { getSnapshot } from '../../src/lib/server/services/snapshot';
import {
  RECEIPT_LIST_PAGE_SIZE,
  getReceiptCapabilities,
  getReceiptDetail,
  getReceiptImage,
  listReceipts,
} from '../../src/lib/server/services/receipts';

type Database = ReturnType<typeof openSqliteDatabase>;
type Row = Record<string, unknown>;

let directory: string;
let storageDir: string;
let database: Database;
let listId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'shopping-list-reads-'));
  storageDir = join(directory, 'receipts');
  mkdirSync(storageDir, { recursive: true });
  database = openSqliteDatabase(join(directory, 'shopping-list.sqlite'));
  migrateAndBootstrap(database, resolve(process.cwd(), 'migrations'));
  listId = (database.prepare('SELECT id FROM lists LIMIT 1').get() as Row)
    .id as string;
});

afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
  delete process.env.RECEIPT_OCR_URL;
  delete process.env.RECEIPT_CURRENCY;
});

function insertReceipt(overrides: Record<string, unknown> = {}): string {
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO receipts
         (id, list_id, status, sha256, image_path, image_bytes, currency,
          subtotal_minor, tax_minor, total_minor, ocr_json, captured_at,
          store_group_id, parse_version, attempts, last_error, processed_at,
          committed_at, created_at, updated_at)
       VALUES (@id, @listId, @status, @sha256, @imagePath, @imageBytes,
               @currency, @subtotalMinor, @taxMinor, @totalMinor, @ocrJson,
               @capturedAt, @storeGroupId, @parseVersion, @attempts,
               @lastError, @processedAt, @committedAt, @createdAt, @updatedAt)`,
    )
    .run({
      id,
      listId,
      status: 'pending',
      sha256: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
      imagePath: `${id}.jpg`,
      imageBytes: 12,
      currency: 'USD',
      subtotalMinor: null,
      taxMinor: null,
      totalMinor: null,
      ocrJson: null,
      capturedAt: null,
      storeGroupId: null,
      parseVersion: 0,
      attempts: 0,
      lastError: null,
      processedAt: null,
      committedAt: null,
      createdAt: '2026-10-17T12:00:00.000Z',
      updatedAt: '2026-10-17T12:00:00.000Z',
      ...overrides,
    });
  return id;
}

function insertLine(
  receiptId: string,
  lineIndex: number,
  overrides: Record<string, unknown> = {},
): string {
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO receipt_lines
         (id, receipt_id, line_index, raw_text, parsed_name, quantity_real,
          quantity_text, quantity_unit, unit_price_minor, total_price_minor,
          is_item_chunk, confidence, catalog_item_id, review_state, bound_via,
          bound_rank)
       VALUES (@id, @receiptId, @lineIndex, @rawText, @parsedName, @quantityReal,
               @quantityText, @quantityUnit, @unitPriceMinor, @totalPriceMinor,
               @isItemChunk, @confidence, @catalogItemId, @reviewState,
               @boundVia, @boundRank)`,
    )
    .run({
      id,
      receiptId,
      lineIndex,
      rawText: `LINE ${lineIndex}`,
      parsedName: null,
      quantityReal: null,
      quantityText: null,
      quantityUnit: null,
      unitPriceMinor: null,
      totalPriceMinor: null,
      isItemChunk: 1,
      confidence: null,
      catalogItemId: null,
      reviewState: 'unreviewed',
      boundVia: null,
      boundRank: null,
      ...overrides,
    });
  return id;
}

describe('receipt list', () => {
  it('returns newest first with image and unknown-line flags', () => {
    const older = insertReceipt({
      createdAt: '2026-10-16T12:00:00.000Z',
      updatedAt: '2026-10-16T12:00:00.000Z',
    });
    const newer = insertReceipt({
      createdAt: '2026-10-17T12:00:00.000Z',
      updatedAt: '2026-10-17T12:00:00.000Z',
      totalMinor: 1860,
    });
    insertLine(newer, 4, { reviewState: 'unknown' });
    insertLine(newer, 5, { reviewState: 'unreviewed' });

    const page = listReceipts({}, database);

    expect(page.nextCursor).toBeNull();
    expect(page.items.map((item) => item.id)).toEqual([newer, older]);
    expect(page.items[0]).toMatchObject({
      id: newer,
      status: 'pending',
      currency: 'USD',
      totalMinor: 1860,
      imageAvailable: true,
      hasUnknowns: true,
      capturedAt: null,
      storeGroupId: null,
      lastError: null,
    });
    expect(page.items[1].hasUnknowns).toBe(false);
  });

  it('reports a receipt without an image as image-unavailable', () => {
    const id = insertReceipt({ imagePath: null });

    const [item] = listReceipts({}, database).items;

    expect(item).toMatchObject({ id, imageAvailable: false });
  });

  it('never lists discarded receipts, even when explicitly filtered', () => {
    const kept = insertReceipt();
    insertReceipt({ status: 'discarded', imagePath: null });

    expect(listReceipts({}, database).items.map((item) => item.id)).toEqual([
      kept,
    ]);
    expect(listReceipts({ status: 'discarded' }, database).items).toEqual([]);
  });

  it('filters by status', () => {
    const review = insertReceipt({ status: 'review' });
    insertReceipt({
      status: 'failed',
      lastError: 'the sidecar is unreachable',
    });

    const page = listReceipts({ status: 'review' }, database);

    expect(page.items.map((item) => item.id)).toEqual([review]);
  });

  it('filters to receipts with an unknown item line', () => {
    const withUnknown = insertReceipt({
      createdAt: '2026-10-17T12:00:00.000Z',
      updatedAt: '2026-10-17T12:00:00.000Z',
    });
    const withBound = insertReceipt({
      createdAt: '2026-10-16T12:00:00.000Z',
      updatedAt: '2026-10-16T12:00:00.000Z',
    });
    insertLine(withUnknown, 0, { reviewState: 'unknown' });
    insertLine(withBound, 0, { reviewState: 'bound' });

    const page = listReceipts({ hasUnknowns: 'true' }, database);

    expect(page.items.map((item) => item.id)).toEqual([withUnknown]);
  });

  it('ignores an unknown line on a parked row', () => {
    const parkedUnknown = insertReceipt();
    insertLine(parkedUnknown, 0, {
      isItemChunk: 0,
      reviewState: 'unknown',
    });

    expect(listReceipts({ hasUnknowns: 'true' }, database).items).toEqual([]);
  });

  it('excludes receipts with unknown item lines when hasUnknowns is false', () => {
    const clean = insertReceipt({
      createdAt: '2026-10-17T12:00:00.000Z',
      updatedAt: '2026-10-17T12:00:00.000Z',
    });
    const unknown = insertReceipt({
      createdAt: '2026-10-16T12:00:00.000Z',
      updatedAt: '2026-10-16T12:00:00.000Z',
    });
    insertLine(unknown, 0, { reviewState: 'unknown' });

    const page = listReceipts({ hasUnknowns: 'false' }, database);

    expect(page.items.map((item) => item.id)).toEqual([clean]);
  });

  it('paginates with a keyset cursor without repeating or skipping rows', () => {
    const ids: string[] = [];
    for (let index = 0; index < RECEIPT_LIST_PAGE_SIZE + 3; index += 1) {
      const createdAt = new Date(
        Date.UTC(2026, 9, 17, 12, 0, index),
      ).toISOString();
      ids.unshift(insertReceipt({ createdAt, updatedAt: createdAt }));
    }

    const first = listReceipts({}, database);
    expect(first.items).toHaveLength(RECEIPT_LIST_PAGE_SIZE);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = listReceipts({ cursor: first.nextCursor }, database);
    expect(second.nextCursor).toBeNull();
    expect(second.items).toHaveLength(3);

    expect([...first.items, ...second.items].map((item) => item.id)).toEqual(
      ids,
    );
  });

  it('rejects a status outside the enum', () => {
    expect(() => listReceipts({ status: 'nonsense' }, database)).toThrowError(
      expect.objectContaining({ status: 400, code: 'INVALID_STATUS' }),
    );
  });

  it('rejects a malformed cursor', () => {
    expect(() =>
      listReceipts({ cursor: 'not-a-cursor' }, database),
    ).toThrowError(
      expect.objectContaining({ status: 400, code: 'INVALID_CURSOR' }),
    );
  });
});

describe('receipt detail', () => {
  it('returns the fields, ordered lines, OCR text, and image flag', () => {
    const id = insertReceipt({
      status: 'review',
      ocrJson: JSON.stringify({
        pages: [
          {
            lines: [
              { text: 'CORNER MARKET' },
              { text: 'MILK 2% 1L' },
              { text: '3.49' },
            ],
          },
        ],
      }),
      processedAt: '2026-10-17T12:01:00.000Z',
      totalMinor: 1860,
    });
    insertLine(id, 2, { rawText: 'TOTAL', isItemChunk: 0 });
    insertLine(id, 0, { rawText: 'MILK 2% 1L', reviewState: 'bound' });

    const detail = getReceiptDetail(id, database);

    expect(detail).toMatchObject({
      id,
      status: 'review',
      currency: 'USD',
      totalMinor: 1860,
      imageAvailable: true,
      ocrText: 'CORNER MARKET\nMILK 2% 1L\n3.49',
      attempts: 0,
    });
    expect(detail.lines.map((line) => line.rawText)).toEqual([
      'MILK 2% 1L',
      'TOTAL',
    ]);
    expect(detail.lines[0]).toMatchObject({
      lineIndex: 0,
      isItemChunk: true,
      reviewState: 'bound',
    });
    expect(detail.lines[1]).toMatchObject({ lineIndex: 2, isItemChunk: false });
  });

  it('has no OCR text until the receipt is processed', () => {
    const id = insertReceipt();

    expect(getReceiptDetail(id, database).ocrText).toBeNull();
  });

  it('reports unknown receipts, including receipts in another list', () => {
    expect(() => getReceiptDetail(randomUUID(), database)).toThrowError(
      expect.objectContaining({ status: 404, code: 'NOT_FOUND' }),
    );

    const otherListId = randomUUID();
    database
      .prepare('INSERT INTO lists (id, name) VALUES (?, ?)')
      .run(otherListId, 'Other list');
    const otherId = randomUUID();
    database
      .prepare(
        `INSERT INTO receipts (id, list_id, status, sha256)
         VALUES (?, ?, 'pending', ?)`,
      )
      .run(otherId, otherListId, 'a'.repeat(64));

    expect(() => getReceiptDetail(otherId, database)).toThrowError(
      expect.objectContaining({ status: 404 }),
    );
  });
});

describe('receipt image', () => {
  it('returns the stored bytes with the type from the stored filename', () => {
    const id = insertReceipt();
    writeFileSync(join(storageDir, `${id}.jpg`), 'fake-image-bytes');

    const image = getReceiptImage(id, database, storageDir);

    expect(image.contentType).toBe('image/jpeg');
    expect(Buffer.from(image.bytes).toString('utf8')).toBe('fake-image-bytes');
  });

  it('reports a purged image as missing', () => {
    const id = insertReceipt({ imagePath: null });

    expect(() => getReceiptImage(id, database, storageDir)).toThrowError(
      expect.objectContaining({ status: 404, code: 'NOT_FOUND' }),
    );
  });

  it('reports a missing file as missing', () => {
    const id = insertReceipt();

    expect(() => getReceiptImage(id, database, storageDir)).toThrowError(
      expect.objectContaining({ status: 404, code: 'NOT_FOUND' }),
    );
  });
});

describe('receipt capabilities', () => {
  it('reports the feature off and the configured currency by default', () => {
    delete process.env.RECEIPT_OCR_URL;
    process.env.RECEIPT_CURRENCY = 'EUR';

    expect(getReceiptCapabilities()).toEqual({
      enabled: false,
      currency: 'EUR',
    });
  });

  it('reports the feature on when an OCR URL is configured', () => {
    process.env.RECEIPT_OCR_URL = 'http://receipt-ocr:8060/ocr';

    expect(getReceiptCapabilities()).toMatchObject({ enabled: true });
  });
});

describe('snapshot isolation', () => {
  it('keeps receipt data out of the snapshot payload', () => {
    const id = insertReceipt({ status: 'review' });
    insertLine(id, 0, { reviewState: 'unknown' });

    const snapshot = getSnapshot(database);

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot).not.toHaveProperty('receipts');
    expect(snapshot).not.toHaveProperty('receiptLines');
  });
});
