import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/lib/server/db/connection';
import { migrateAndBootstrap } from '../../src/lib/server/db/lifecycle.js';
import { openSqliteDatabase } from '../../src/lib/server/db/sqlite.js';
import { receiptDetailSchema } from '../../src/lib/shared/schemas';
import { GET as detailRoute } from '../../src/routes/api/receipts/[id]/+server';
import {
  GET as detailGet,
  PATCH as detailPatch,
} from '../../src/routes/api/receipts/[id]/+server';

type DetailEvent = Parameters<typeof detailRoute>[0];
type PatchEvent = Parameters<typeof detailPatch>[0];

const origin = 'http://localhost:5173';
const ITEM_ID = '00000000-0000-4000-8000-0000000000aa';

let directory: string;
let databasePath: string;
let listId: string;
let storeGroupId: string;
let categoryGroupId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'shopping-list-review-'));
  process.env.CANONICAL_ORIGIN = origin;
  process.env.RECEIPT_STORAGE_DIR = join(directory, 'receipts');
  mkdirSync(process.env.RECEIPT_STORAGE_DIR, { recursive: true });
  databasePath = join(directory, 'shopping-list.sqlite');
  process.env.DATABASE_PATH = databasePath;
  process.env.RECEIPT_CURRENCY = 'USD';
  closeDatabase();

  const database = openSqliteDatabase(databasePath);
  migrateAndBootstrap(database, resolve(process.cwd(), 'migrations'));
  listId = (
    database.prepare('SELECT id FROM lists LIMIT 1').get() as { id: string }
  ).id;
  storeGroupId = randomUUID();
  categoryGroupId = randomUUID();
  const insertGroup = database.prepare(
    `INSERT INTO groups (id, list_id, name, normalized_name, kind, color, position)
     VALUES (?, ?, ?, ?, ?, '#d6a453', ?)`,
  );
  insertGroup.run(
    storeGroupId,
    listId,
    'Corner Market',
    'corner market',
    'store',
    0,
  );
  insertGroup.run(categoryGroupId, listId, 'Dairy', 'dairy', 'category', 1);
  database
    .prepare(
      `INSERT INTO catalog_items (id, list_id, display_name, normalized_name)
       VALUES (?, ?, 'Milk', 'milk')`,
    )
    .run(ITEM_ID, listId);
  database.close();
});

afterEach(() => {
  closeDatabase();
  rmSync(directory, { recursive: true, force: true });
  delete process.env.RECEIPT_CURRENCY;
});

/** A `review` receipt ready for edits, plus one item line and one parked row. */
function insertReviewableReceipt(overrides: Record<string, unknown> = {}) {
  const database = openSqliteDatabase(databasePath);
  try {
    const id = randomUUID();
    database
      .prepare(
        `INSERT INTO receipts
           (id, list_id, status, sha256, image_path, image_bytes, currency,
            subtotal_minor, tax_minor, total_minor, ocr_json, store_group_id,
            created_at, updated_at)
         VALUES (@id, @listId, @status, @sha256, NULL, NULL, 'USD',
                 349, NULL, 349, @ocrJson, @storeGroupId,
                 '2026-10-17T12:00:00.000Z', @updatedAt)`,
      )
      .run({
        id,
        listId,
        status: 'review',
        sha256: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
        ocrJson: JSON.stringify({
          pages: [{ lines: [{ text: 'MILK 2% 1L' }, { text: '3.49' }] }],
        }),
        storeGroupId: null,
        updatedAt: '2026-10-17T12:00:00.000Z',
        ...overrides,
      });

    const itemLineId = randomUUID();
    const insertLine = database.prepare(
      `INSERT INTO receipt_lines
         (id, receipt_id, line_index, raw_text, parsed_name, quantity_real,
          quantity_text, quantity_unit, unit_price_minor, total_price_minor,
          is_item_chunk, confidence, review_state, catalog_item_id, bound_via,
          created_at, updated_at)
       VALUES (@id, @receiptId, @lineIndex, @rawText, @parsedName, @quantityReal,
               @quantityText, @quantityUnit, @unitPriceMinor, @totalPriceMinor,
               @isItemChunk, 0.96, @reviewState, @catalogItemId, @boundVia,
               '2026-10-17T12:00:00.000Z', '2026-10-17T12:00:00.000Z')`,
    );
    insertLine.run({
      id: itemLineId,
      receiptId: id,
      lineIndex: 0,
      rawText: 'MILK 2% 1L',
      parsedName: 'MILK 2% 1L',
      quantityReal: null,
      quantityText: null,
      quantityUnit: null,
      unitPriceMinor: null,
      totalPriceMinor: 349,
      isItemChunk: 1,
      reviewState: 'unreviewed',
      catalogItemId: null,
      boundVia: null,
    });
    const parkedLineId = randomUUID();
    insertLine.run({
      id: parkedLineId,
      receiptId: id,
      lineIndex: 1,
      rawText: 'SUBTOTAL',
      parsedName: null,
      quantityReal: null,
      quantityText: null,
      quantityUnit: null,
      unitPriceMinor: null,
      totalPriceMinor: 349,
      isItemChunk: 0,
      reviewState: 'unreviewed',
      catalogItemId: null,
      boundVia: null,
    });
    return { id, itemLineId, parkedLineId };
  } finally {
    database.close();
  }
}

function patchEvent(id: string, body: unknown): PatchEvent {
  const url = new URL(`${origin}/api/receipts/${id}`);
  return {
    url,
    params: { id },
    request: new Request(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as unknown as PatchEvent;
}

function detailEvent(id: string): DetailEvent {
  const url = new URL(`${origin}/api/receipts/${id}`);
  return {
    url,
    params: { id },
    request: new Request(url),
  } as unknown as DetailEvent;
}

type Row = Record<string, unknown>;

function receiptRow(id: string): Row {
  const database = openSqliteDatabase(databasePath);
  try {
    return database
      .prepare('SELECT * FROM receipts WHERE id = ?')
      .get(id) as Row;
  } finally {
    database.close();
  }
}

function lineRow(id: string): Row {
  const database = openSqliteDatabase(databasePath);
  try {
    return database
      .prepare('SELECT * FROM receipt_lines WHERE id = ?')
      .get(id) as Row;
  } finally {
    database.close();
  }
}

async function patch(id: string, body: unknown) {
  return detailPatch(patchEvent(id, body));
}

describe('PATCH /api/receipts/[id] — review states', () => {
  it('marks a line unknown, persists it, and returns the fresh detail', async () => {
    const { id, itemLineId } = insertReviewableReceipt();

    const response = await patch(id, {
      expectedUpdatedAt: '2026-10-17T12:00:00.000Z',
      lines: [{ id: itemLineId, reviewState: 'unknown' }],
    });

    expect(response.status).toBe(200);
    const detail = receiptDetailSchema.parse(await response.json());
    expect(detail.lines.find((line) => line.id === itemLineId)).toMatchObject({
      reviewState: 'unknown',
    });
    expect(detail.updatedAt).not.toBe('2026-10-17T12:00:00.000Z');
    expect(detail.hasUnknowns).toBe(true);

    // The write survives a fresh read, and the row carries it too.
    const reread = receiptDetailSchema.parse(
      await (await detailGet(detailEvent(id))).json(),
    );
    expect(
      reread.lines.find((line) => line.id === itemLineId)?.reviewState,
    ).toBe('unknown');
    expect(lineRow(itemLineId).review_state).toBe('unknown');
  });

  it('releases a line back to unreviewed, and the unknown flag goes with it', async () => {
    const { id, itemLineId } = insertReviewableReceipt();
    await patch(id, {
      expectedUpdatedAt: '2026-10-17T12:00:00.000Z',
      lines: [{ id: itemLineId, reviewState: 'unknown' }],
    });
    const afterFirst = receiptRow(id).updated_at as string;

    const response = await patch(id, {
      expectedUpdatedAt: afterFirst,
      lines: [{ id: itemLineId, reviewState: 'unreviewed' }],
    });

    const detail = receiptDetailSchema.parse(await response.json());
    expect(
      detail.lines.find((line) => line.id === itemLineId)?.reviewState,
    ).toBe('unreviewed');
    expect(detail.hasUnknowns).toBe(false);
  });

  it('marks a line skipped', async () => {
    const { id, itemLineId } = insertReviewableReceipt();

    const response = await patch(id, {
      expectedUpdatedAt: '2026-10-17T12:00:00.000Z',
      lines: [{ id: itemLineId, reviewState: 'skipped' }],
    });

    const detail = receiptDetailSchema.parse(await response.json());
    expect(
      detail.lines.find((line) => line.id === itemLineId)?.reviewState,
    ).toBe('skipped');
    expect(detail.hasUnknowns).toBe(false);
  });

  it('records a binding with its provenance', async () => {
    const { id, itemLineId } = insertReviewableReceipt();

    await patch(id, {
      expectedUpdatedAt: '2026-10-17T12:00:00.000Z',
      lines: [
        {
          id: itemLineId,
          reviewState: 'bound',
          catalogItemId: ITEM_ID,
          boundVia: 'suggested',
          boundRank: 1,
        },
      ],
    });

    expect(lineRow(itemLineId)).toMatchObject({
      review_state: 'bound',
      catalog_item_id: ITEM_ID,
      bound_via: 'suggested',
      bound_rank: 1,
    });
  });

  it('refuses a binding to an item outside the list', async () => {
    const { id, itemLineId } = insertReviewableReceipt();

    const response = await patch(id, {
      expectedUpdatedAt: '2026-10-17T12:00:00.000Z',
      lines: [
        {
          id: itemLineId,
          reviewState: 'bound',
          catalogItemId: randomUUID(),
        },
      ],
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'INVALID_ITEM' },
    });
    expect(lineRow(itemLineId).review_state).toBe('unreviewed');
  });
});

describe('PATCH /api/receipts/[id] — line edits', () => {
  it('persists text, quantity, unit and prices while ocr_json keeps the original', async () => {
    const { id, itemLineId } = insertReviewableReceipt();

    const response = await patch(id, {
      expectedUpdatedAt: '2026-10-17T12:00:00.000Z',
      lines: [
        {
          id: itemLineId,
          rawText: 'MILK 2% 2L',
          quantityReal: 2,
          quantityText: '2 @ 2.00',
          quantityUnit: 'ea',
          unitPriceMinor: 200,
          totalPriceMinor: 400,
        },
      ],
    });

    expect(response.status).toBe(200);
    const detail = receiptDetailSchema.parse(await response.json());
    expect(detail.lines[0]).toMatchObject({
      rawText: 'MILK 2% 2L',
      quantityReal: 2,
      quantityText: '2 @ 2.00',
      quantityUnit: 'ea',
      unitPriceMinor: 200,
      totalPriceMinor: 400,
    });

    // The raw engine output is the immutable original, edits included.
    expect(receiptRow(id).ocr_json).toContain('MILK 2% 1L');
    expect(lineRow(itemLineId)).toMatchObject({
      raw_text: 'MILK 2% 2L',
      quantity_real: 2,
      quantity_unit: 'ea',
      unit_price_minor: 200,
      total_price_minor: 400,
    });
  });

  it('clears a quantity and a price', async () => {
    const { id, itemLineId } = insertReviewableReceipt();
    await patch(id, {
      expectedUpdatedAt: '2026-10-17T12:00:00.000Z',
      lines: [{ id: itemLineId, quantityReal: 2, quantityUnit: 'ea' }],
    });

    const response = await patch(id, {
      expectedUpdatedAt: receiptRow(id).updated_at as string,
      lines: [
        {
          id: itemLineId,
          quantityReal: null,
          quantityUnit: null,
          totalPriceMinor: null,
        },
      ],
    });

    const detail = receiptDetailSchema.parse(await response.json());
    expect(detail.lines[0]).toMatchObject({
      quantityReal: null,
      quantityUnit: null,
      totalPriceMinor: null,
    });
  });

  it('corrects the receipt-level totals and store', async () => {
    const { id } = insertReviewableReceipt();

    const response = await patch(id, {
      expectedUpdatedAt: '2026-10-17T12:00:00.000Z',
      storeGroupId,
      subtotalMinor: 350,
      taxMinor: 10,
      totalMinor: 360,
    });

    const detail = receiptDetailSchema.parse(await response.json());
    expect(detail).toMatchObject({
      storeGroupId,
      subtotalMinor: 350,
      taxMinor: 10,
      totalMinor: 360,
    });
  });

  it('clears the store again', async () => {
    const { id } = insertReviewableReceipt();
    await patch(id, {
      expectedUpdatedAt: '2026-10-17T12:00:00.000Z',
      storeGroupId,
    });

    const response = await patch(id, {
      expectedUpdatedAt: receiptRow(id).updated_at as string,
      storeGroupId: null,
    });

    expect(await response.json()).toMatchObject({ storeGroupId: null });
  });

  it('refuses a store that is not a store group', async () => {
    const { id } = insertReviewableReceipt();

    const response = await patch(id, {
      expectedUpdatedAt: '2026-10-17T12:00:00.000Z',
      storeGroupId: categoryGroupId,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'INVALID_STORE' },
    });
  });

  it('refuses a line that is not this receipt’s', async () => {
    const { id } = insertReviewableReceipt();
    const other = insertReviewableReceipt();

    const response = await patch(id, {
      expectedUpdatedAt: '2026-10-17T12:00:00.000Z',
      lines: [{ id: other.itemLineId, reviewState: 'unknown' }],
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'INVALID_LINE' },
    });
    expect(lineRow(other.itemLineId).review_state).toBe('unreviewed');
  });

  it('refuses to edit a parked row', async () => {
    const { id, parkedLineId } = insertReviewableReceipt();

    const response = await patch(id, {
      expectedUpdatedAt: '2026-10-17T12:00:00.000Z',
      lines: [{ id: parkedLineId, reviewState: 'skipped' }],
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'INVALID_LINE' },
    });
  });

  it('refuses a currency other than the configured one', async () => {
    const { id } = insertReviewableReceipt();

    const response = await patch(id, {
      expectedUpdatedAt: '2026-10-17T12:00:00.000Z',
      currency: 'GBP',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'INVALID_CURRENCY' },
    });
  });

  it('rejects a line edit the schema refuses', async () => {
    const { id, itemLineId } = insertReviewableReceipt();

    const response = await patch(id, {
      expectedUpdatedAt: '2026-10-17T12:00:00.000Z',
      lines: [{ id: itemLineId, quantityReal: 0 }],
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR' },
    });
  });

  it('changes nothing for an empty patch', async () => {
    const { id } = insertReviewableReceipt();

    const response = await patch(id, {
      expectedUpdatedAt: '2026-10-17T12:00:00.000Z',
    });

    expect(response.status).toBe(200);
    expect(receiptRow(id).updated_at).toBe('2026-10-17T12:00:00.000Z');
  });
});

describe('PATCH /api/receipts/[id] — guards', () => {
  it('refuses a stale edit with a conflict, writing nothing', async () => {
    const { id, itemLineId } = insertReviewableReceipt();

    const response = await patch(id, {
      expectedUpdatedAt: '2026-10-17T11:59:00.000Z',
      lines: [{ id: itemLineId, reviewState: 'unknown' }],
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'RECEIPT_CHANGED' },
    });
    expect(lineRow(itemLineId).review_state).toBe('unreviewed');
    expect(receiptRow(id).updated_at).toBe('2026-10-17T12:00:00.000Z');
  });

  it('refuses a second edit carrying the first edit’s token', async () => {
    const { id, itemLineId } = insertReviewableReceipt();
    await patch(id, {
      expectedUpdatedAt: '2026-10-17T12:00:00.000Z',
      lines: [{ id: itemLineId, reviewState: 'unknown' }],
    });

    const response = await patch(id, {
      expectedUpdatedAt: '2026-10-17T12:00:00.000Z',
      lines: [{ id: itemLineId, reviewState: 'skipped' }],
    });

    expect(response.status).toBe(409);
    expect(lineRow(itemLineId).review_state).toBe('unknown');
  });

  it('rejects every write outside review', async () => {
    for (const status of [
      'pending',
      'processing',
      'committed',
      'discarded',
      'failed',
    ] as const) {
      // A committed receipt must carry a store (schema CHECK); the others do not.
      const { id, itemLineId } = insertReviewableReceipt({
        status,
        storeGroupId: status === 'committed' ? storeGroupId : null,
      });

      const response = await patch(id, {
        expectedUpdatedAt: '2026-10-17T12:00:00.000Z',
        lines: [{ id: itemLineId, reviewState: 'unknown' }],
      });

      expect(response.status, status).toBe(409);
      expect(await response.json(), status).toMatchObject({
        error: { code: 'RECEIPT_NOT_EDITABLE' },
      });
      expect(lineRow(itemLineId).review_state, status).toBe('unreviewed');
    }
  });

  it('reports an unknown receipt as missing', async () => {
    const response = await patch(randomUUID(), {
      expectedUpdatedAt: '2026-10-17T12:00:00.000Z',
    });

    expect(response.status).toBe(404);
  });

  it('requires JSON', async () => {
    const { id } = insertReviewableReceipt();
    const url = new URL(`${origin}/api/receipts/${id}`);

    const response = await detailPatch({
      url,
      params: { id },
      request: new Request(url, {
        method: 'PATCH',
        headers: { 'content-type': 'text/plain' },
        body: 'nope',
      }),
    } as unknown as PatchEvent);

    expect(response.status).toBe(415);
  });
});
