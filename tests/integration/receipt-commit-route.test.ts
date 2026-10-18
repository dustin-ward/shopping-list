import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handle } from '../../src/hooks.server';
import { closeDatabase } from '../../src/lib/server/db/connection';
import { migrateAndBootstrap } from '../../src/lib/server/db/lifecycle.js';
import { openSqliteDatabase } from '../../src/lib/server/db/sqlite.js';
import { parseReceiptOcr } from '../../src/lib/server/receipts/parser';
import {
  getReceiptDetail,
  listReceipts,
  writeReceiptParse,
} from '../../src/lib/server/services/receipts';
import { receiptDetailSchema } from '../../src/lib/shared/schemas';
import { POST as commitRoute } from '../../src/routes/api/receipts/[id]/commit/+server';
import { POST as discardRoute } from '../../src/routes/api/receipts/[id]/discard/+server';
import { PATCH as patchRoute } from '../../src/routes/api/receipts/[id]/+server';
import { POST as uploadRoute } from '../../src/routes/api/receipts/+server';

/**
 * The write path through the real routes and a real database: what a commit
 * writes, what a refused commit does not write, and what a discard keeps.
 */

const origin = 'http://localhost:5173';
const host = new URL(origin).host;

let directory: string;
let storageDir: string;
let databasePath: string;
let listId: string;
let storeGroupId: string;
let itemId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'shopping-list-commit-'));
  storageDir = join(directory, 'receipts');
  mkdirSync(storageDir, { recursive: true });
  process.env.CANONICAL_ORIGIN = origin;
  process.env.RECEIPT_STORAGE_DIR = storageDir;
  process.env.RECEIPT_CURRENCY = 'USD';
  databasePath = join(directory, 'shopping-list.sqlite');
  process.env.DATABASE_PATH = databasePath;
  closeDatabase();

  const database = openSqliteDatabase(databasePath);
  migrateAndBootstrap(database, resolve(process.cwd(), 'migrations'));
  listId = (database.prepare('SELECT id FROM lists LIMIT 1').get() as
    { id: string } | undefined)!.id;

  storeGroupId = randomUUID();
  database
    .prepare(
      `INSERT INTO groups (id, list_id, name, normalized_name, kind, position)
       VALUES (?, ?, 'Corner Market', 'corner market', 'store', 0)`,
    )
    .run(storeGroupId, listId);
  database
    .prepare(
      `INSERT INTO groups (id, list_id, name, normalized_name, kind, position)
       VALUES (?, ?, 'Dairy', 'dairy', 'category', 1)`,
    )
    .run(randomUUID(), listId);

  itemId = randomUUID();
  database
    .prepare(
      `INSERT INTO catalog_items (id, list_id, display_name, normalized_name)
       VALUES (?, ?, 'Milk', 'milk')`,
    )
    .run(itemId, listId);
  database.close();
});

afterEach(() => {
  closeDatabase();
  rmSync(directory, { recursive: true, force: true });
  delete process.env.RECEIPT_CURRENCY;
});

type Row = Record<string, unknown>;

function openDatabase() {
  return openSqliteDatabase(databasePath);
}

function query<T extends Row>(sql: string, ...parameters: unknown[]): T[] {
  const database = openDatabase();
  try {
    return database.prepare(sql).all(...parameters) as T[];
  } finally {
    database.close();
  }
}

function one<T extends Row>(sql: string, ...parameters: unknown[]): T {
  const rows = query<T>(sql, ...parameters);
  expect(rows, sql).toHaveLength(1);
  return rows[0]!;
}

function revision(): number {
  return one<{ revision: number }>(
    'SELECT revision FROM app_state WHERE id = 1',
  ).revision;
}

function receiptRow(id: string): Row {
  return one<Row>('SELECT * FROM receipts WHERE id = ?', id);
}

function lineRow(id: string): Row {
  return one<Row>('SELECT * FROM receipt_lines WHERE id = ?', id);
}

/** A reviewable receipt: one bound line, one drafted item, one unknown line, a parked row. */
function insertReviewableReceipt(overrides: Record<string, unknown> = {}) {
  const database = openDatabase();
  try {
    const id = randomUUID();
    const imagePath = `${id}.png`;
    writeFileSync(join(storageDir, imagePath), 'receipt-image-bytes');

    database
      .prepare(
        `INSERT INTO receipts
           (id, list_id, status, sha256, image_path, image_bytes, currency,
            subtotal_minor, tax_minor, total_minor, ocr_json, store_group_id,
            created_at, updated_at)
         VALUES (@id, @listId, @status, @sha256, @imagePath, 18, 'USD',
                 349, NULL, 349, @ocrJson, @storeGroupId,
                 '2026-10-17T12:00:00.000Z', @updatedAt)`,
      )
      .run({
        id,
        listId,
        status: 'review',
        sha256: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
        imagePath,
        ocrJson: JSON.stringify({
          pages: [
            {
              lines: [
                { text: 'MILK 2% 1L' },
                { text: '3.49' },
                { text: 'SOURDOUGH BREAD' },
                { text: 'SUBTOTAL' },
                { text: '17.55' },
              ],
            },
          ],
        }),
        storeGroupId: null,
        updatedAt: '2026-10-17T12:00:00.000Z',
        ...overrides,
      });

    const insertLine = database.prepare(
      `INSERT INTO receipt_lines
         (id, receipt_id, line_index, raw_text, parsed_name, quantity_real,
          quantity_text, quantity_unit, unit_price_minor, total_price_minor,
          is_item_chunk, confidence, review_state, catalog_item_id, bound_via,
          created_at, updated_at)
       VALUES (@id, @receiptId, @lineIndex, @rawText, @parsedName, NULL, NULL,
               NULL, NULL, @totalPriceMinor, @isItemChunk, 0.96, @reviewState,
               @catalogItemId, @boundVia,
               '2026-10-17T12:00:00.000Z', '2026-10-17T12:00:00.000Z')`,
    );
    const boundLineId = randomUUID();
    insertLine.run({
      id: boundLineId,
      receiptId: id,
      lineIndex: 0,
      rawText: 'MILK 2% 1L',
      parsedName: 'MILK 2% 1L',
      totalPriceMinor: 349,
      isItemChunk: 1,
      reviewState: 'bound',
      catalogItemId: itemId,
      boundVia: 'manual',
    });
    const draftLineId = randomUUID();
    insertLine.run({
      id: draftLineId,
      receiptId: id,
      lineIndex: 1,
      rawText: 'SOURDOUGH BREAD',
      parsedName: 'SOURDOUGH BREAD',
      totalPriceMinor: 499,
      isItemChunk: 1,
      reviewState: 'new',
      catalogItemId: null,
      boundVia: null,
    });
    const unknownLineId = randomUUID();
    insertLine.run({
      id: unknownLineId,
      receiptId: id,
      lineIndex: 2,
      rawText: 'MYSTERY ITEM',
      parsedName: 'MYSTERY ITEM',
      totalPriceMinor: 100,
      isItemChunk: 1,
      reviewState: 'unknown',
      catalogItemId: null,
      boundVia: null,
    });
    const parkedLineId = randomUUID();
    insertLine.run({
      id: parkedLineId,
      receiptId: id,
      lineIndex: 3,
      rawText: 'SUBTOTAL',
      parsedName: null,
      totalPriceMinor: 1755,
      isItemChunk: 0,
      reviewState: 'unreviewed',
      catalogItemId: null,
      boundVia: null,
    });

    return {
      id,
      imagePath,
      boundLineId,
      draftLineId,
      unknownLineId,
      parkedLineId,
    };
  } finally {
    database.close();
  }
}

/** Run one request through the server hook and then the route under test. */
async function submit(
  route: (event: never) => Response | Promise<Response>,
  request: Request,
  params: Record<string, string>,
): Promise<Response> {
  const event = {
    request,
    url: new URL(request.url),
    params,
  };
  return handle({
    event,
    resolve: async () => route(event as never),
  } as never);
}

function commit(id: string, body: unknown): Promise<Response> {
  return submit(
    commitRoute,
    new Request(`${origin}/api/receipts/${id}/commit`, {
      method: 'POST',
      headers: { host, origin, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { id },
  );
}

function discard(id: string): Promise<Response> {
  return submit(
    discardRoute,
    new Request(`${origin}/api/receipts/${id}/discard`, {
      method: 'POST',
      headers: { host, origin, 'content-type': 'application/json' },
      body: '{}',
    }),
    { id },
  );
}

function upload(): Promise<Response> {
  const body = new FormData();
  const bytes = new Uint8Array(256);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  body.set('image', new Blob([bytes], { type: 'image/jpeg' }), 'receipt.jpg');
  return submit(
    uploadRoute,
    new Request(`${origin}/api/receipts`, {
      method: 'POST',
      headers: { host, origin },
      body,
    }),
    {},
  );
}

/** The commit payload a fully reviewed receipt sends. */
function commitBody(overrides: Record<string, unknown> = {}) {
  return {
    expectedUpdatedAt: '2026-10-17T12:00:00.000Z',
    ...overrides,
  };
}

describe('POST /api/receipts/[id]/commit — the happy path', () => {
  it('lands items, store, aliases and receipt state in one transaction', async () => {
    const { id, draftLineId, boundLineId, unknownLineId, parkedLineId } =
      insertReviewableReceipt();
    const before = revision();

    const response = await commit(
      id,
      commitBody({
        itemDrafts: [{ lineId: draftLineId, name: 'Sourdough loaf' }],
        storeDraft: 'Trader Joe’s',
      }),
    );

    expect(response.status).toBe(200);
    const detail = receiptDetailSchema.parse(await response.json());
    expect(detail.status).toBe('committed');
    expect(detail.committedAt).not.toBeNull();
    expect(detail.imageAvailable).toBe(true);

    // The store the reviewer drafted exists as a store group, and the receipt
    // points at it.
    const store = one<{
      id: string;
      kind: string;
      name: string;
      position: number;
    }>(
      'SELECT id, kind, name, position FROM groups WHERE id = ?',
      detail.storeGroupId,
    );
    expect(store).toEqual({
      id: detail.storeGroupId,
      kind: 'store',
      name: 'Trader Joe’s',
      position: 2,
    });

    // The drafted item was created once, and the line kept its `new` state with
    // `created` provenance.
    const item = one<{
      id: string;
      display_name: string;
      normalized_name: string;
    }>(
      "SELECT id, display_name, normalized_name FROM catalog_items WHERE normalized_name = 'sourdough loaf'",
    );
    expect(item.display_name).toBe('Sourdough loaf');
    expect(lineRow(draftLineId)).toMatchObject({
      catalog_item_id: item.id,
      review_state: 'new',
      bound_via: 'created',
      bound_rank: null,
    });
    // The bound line is untouched, the unknown line keeps its observation, and
    // the parked row is exactly as the parser settled it.
    expect(lineRow(boundLineId)).toMatchObject({
      catalog_item_id: itemId,
      review_state: 'bound',
      bound_via: 'manual',
    });
    expect(lineRow(unknownLineId)).toMatchObject({
      catalog_item_id: null,
      review_state: 'unknown',
      bound_via: null,
    });
    expect(lineRow(parkedLineId)).toMatchObject({
      review_state: 'unreviewed',
      is_item_chunk: 0,
      raw_text: 'SUBTOTAL',
    });

    // Every decided line taught its reviewed text, and nothing taught the
    // unknown line's.
    const aliases = query<{
      alias_text: string;
      normalized_alias: string;
      catalog_item_id: string;
      source: string;
      created_by_receipt_line_id: string;
    }>(
      `SELECT alias_text, normalized_alias, catalog_item_id, source,
              created_by_receipt_line_id
         FROM item_aliases
        ORDER BY normalized_alias`,
    );
    expect(aliases).toEqual([
      {
        alias_text: 'MILK 2% 1L',
        normalized_alias: 'milk 2% 1l',
        catalog_item_id: itemId,
        source: 'review',
        created_by_receipt_line_id: boundLineId,
      },
      {
        alias_text: 'SOURDOUGH BREAD',
        normalized_alias: 'sourdough bread',
        catalog_item_id: item.id,
        source: 'review',
        created_by_receipt_line_id: draftLineId,
      },
    ]);

    // A created item and a created store are snapshot-visible: one bump.
    expect(revision()).toBe(before + 1);
  });

  it('writes nothing when the totals delta is large — it is a warning, not a gate', async () => {
    const { id, draftLineId } = insertReviewableReceipt({ total_minor: 999 });

    const response = await commit(
      id,
      commitBody({
        itemDrafts: [{ lineId: draftLineId, name: 'Sourdough loaf' }],
        storeDraft: 'Trader Joe’s',
      }),
    );

    expect(response.status).toBe(200);
    expect(receiptRow(id).status).toBe('committed');
  });

  it('drops no line and rewrites no text — the commit only binds', async () => {
    const receipt = insertReviewableReceipt();
    const lineRows = () =>
      query<{
        id: string;
        raw_text: string;
        line_index: number;
        is_item_chunk: number;
      }>(
        `SELECT id, raw_text, line_index, is_item_chunk
           FROM receipt_lines
          WHERE receipt_id = ?
          ORDER BY line_index, id`,
        receipt.id,
      );
    const before = lineRows();
    expect(before).toHaveLength(4);

    const response = await commit(
      receipt.id,
      commitBody({
        itemDrafts: [{ lineId: receipt.draftLineId, name: 'Sourdough loaf' }],
        storeDraft: 'Trader Joe’s',
      }),
    );

    expect(response.status).toBe(200);
    // Same rows, same printed text, same order — parked and unknown lines
    // included. The commit is what the reviewer's decisions add, never a
    // filter over what the parser read (ADR 0001).
    expect(lineRows()).toEqual(before);
    // The totals the reviewer saw are the parser's, untouched by the commit.
    expect(receiptRow(receipt.id)).toMatchObject({
      subtotal_minor: 349,
      total_minor: 349,
    });
  });

  it('binds the next receipt automatically from the alias this commit learned', async () => {
    const { id, draftLineId } = insertReviewableReceipt();
    await commit(
      id,
      commitBody({
        itemDrafts: [{ lineId: draftLineId, name: 'Sourdough loaf' }],
        storeDraft: 'Trader Joe’s',
      }),
    );

    // A second receipt prints the same phrasing; the worker's parse binds it.
    const next = insertReviewableReceipt();
    const database = openDatabase();
    try {
      writeReceiptParse(
        database,
        next.id,
        parseReceiptOcr(
          JSON.stringify({
            pages: [
              {
                lines: [
                  {
                    box: [12, 124, 360, 140],
                    text: 'SOURDOUGH BREAD',
                    conf: 0.97,
                  },
                  { box: [380, 124, 452, 140], text: '4.99', conf: 0.98 },
                ],
              },
            ],
          }),
        ),
        'USD',
      );
    } finally {
      database.close();
    }

    const line = one<Row>(
      "SELECT * FROM receipt_lines WHERE receipt_id = ? AND raw_text = 'SOURDOUGH BREAD'",
      next.id,
    );
    expect(line).toMatchObject({
      review_state: 'bound',
      bound_via: 'auto',
      bound_rank: null,
    });
    expect(line.catalog_item_id).toBe(
      one<{ id: string }>(
        "SELECT id FROM catalog_items WHERE normalized_name = 'sourdough loaf'",
      ).id,
    );
  });

  it('revives a soft-deleted alias instead of adding a second row', async () => {
    const first = insertReviewableReceipt({ storeGroupId });
    const committed = await commit(
      first.id,
      commitBody({
        itemDrafts: [{ lineId: first.draftLineId, name: 'Sourdough loaf' }],
      }),
    );
    expect(committed.status).toBe(200);

    const database = openDatabase();
    try {
      database
        .prepare(
          "UPDATE item_aliases SET deleted_at = '2026-10-18T00:00:00.000Z' WHERE normalized_alias = 'sourdough bread'",
        )
        .run();
    } finally {
      database.close();
    }

    const second = insertReviewableReceipt();
    const again = await commit(
      second.id,
      commitBody({
        itemDrafts: [{ lineId: second.draftLineId, name: 'Sourdough loaf' }],
        storeDraft: 'Trader Joe’s',
      }),
    );
    expect(again.status).toBe(200);

    const aliases = query<Row>(
      "SELECT * FROM item_aliases WHERE normalized_alias = 'sourdough bread'",
    );
    expect(aliases).toHaveLength(1);
    expect(aliases[0]).toMatchObject({
      deleted_at: null,
      created_by_receipt_line_id: second.draftLineId,
    });
  });
});

describe('POST /api/receipts/[id]/commit — the gate', () => {
  it('refuses an unreviewed item line, writing nothing', async () => {
    const { id, draftLineId, boundLineId } = insertReviewableReceipt();
    const database = openDatabase();
    try {
      database
        .prepare(
          "UPDATE receipt_lines SET review_state = 'unreviewed', catalog_item_id = NULL, bound_via = NULL WHERE id = ?",
        )
        .run(draftLineId);
    } finally {
      database.close();
    }
    const before = revision();

    const response = await commit(
      id,
      commitBody({
        itemDrafts: [{ lineId: draftLineId, name: 'Sourdough loaf' }],
        storeDraft: 'Trader Joe’s',
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'RECEIPT_NOT_REVIEWED',
        details: { lineIds: [draftLineId] },
      },
    });
    expect(receiptRow(id)).toMatchObject({
      status: 'review',
      updated_at: '2026-10-17T12:00:00.000Z',
      store_group_id: null,
    });
    expect(lineRow(boundLineId).catalog_item_id).toBe(itemId);
    expect(query('SELECT id FROM item_aliases')).toEqual([]);
    expect(
      query(
        "SELECT id FROM catalog_items WHERE normalized_name = 'sourdough loaf'",
      ),
    ).toEqual([]);
    expect(query("SELECT id FROM groups WHERE name = 'Trader Joe’s'")).toEqual(
      [],
    );
    expect(revision()).toBe(before);
  });

  it('refuses a commit with no store, writing nothing', async () => {
    const { id, draftLineId } = insertReviewableReceipt();
    const before = revision();

    const response = await commit(
      id,
      commitBody({
        itemDrafts: [{ lineId: draftLineId, name: 'Sourdough loaf' }],
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'RECEIPT_STORE_REQUIRED' },
    });
    expect(receiptRow(id)).toMatchObject({
      status: 'review',
      store_group_id: null,
    });
    expect(
      query(
        "SELECT id FROM catalog_items WHERE normalized_name = 'sourdough loaf'",
      ),
    ).toEqual([]);
    expect(query('SELECT id FROM item_aliases')).toEqual([]);
    expect(revision()).toBe(before);
  });

  it('refuses a commit from a stale view, writing nothing', async () => {
    const { id, draftLineId } = insertReviewableReceipt();

    const response = await commit(id, {
      expectedUpdatedAt: '2026-10-17T11:59:00.000Z',
      itemDrafts: [{ lineId: draftLineId, name: 'Sourdough loaf' }],
      storeDraft: 'Trader Joe’s',
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'RECEIPT_CHANGED' },
    });
    expect(receiptRow(id)).toMatchObject({
      status: 'review',
      updated_at: '2026-10-17T12:00:00.000Z',
    });
    expect(query('SELECT id FROM item_aliases')).toEqual([]);
  });

  it('refuses a second commit with a conflict and learns no second alias', async () => {
    const { id, draftLineId } = insertReviewableReceipt();
    const first = await commit(
      id,
      commitBody({
        itemDrafts: [{ lineId: draftLineId, name: 'Sourdough loaf' }],
        storeDraft: 'Trader Joe’s',
      }),
    );
    expect(first.status).toBe(200);
    const committedAt = receiptRow(id).committed_at;
    const after = revision();

    const response = await commit(
      id,
      commitBody({
        itemDrafts: [{ lineId: draftLineId, name: 'Sourdough loaf' }],
        storeDraft: 'Trader Joe’s',
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'RECEIPT_ALREADY_COMMITTED' },
    });
    expect(receiptRow(id).committed_at).toBe(committedAt);
    expect(query('SELECT id FROM item_aliases')).toHaveLength(2);
    expect(revision()).toBe(after);
  });

  it('refuses every status that is not review', async () => {
    for (const status of [
      'pending',
      'processing',
      'failed',
      'discarded',
    ] as const) {
      const { id } = insertReviewableReceipt({ status });

      const response = await commit(id, commitBody());

      expect(response.status, status).toBe(409);
      expect(await response.json(), status).toMatchObject({
        error: { code: 'RECEIPT_NOT_COMMITTABLE' },
      });
      expect(receiptRow(id).status, status).toBe(status);
    }
  });

  it('does not bump the revision when it only bound rows the list already had', async () => {
    const { id, draftLineId } = insertReviewableReceipt({ storeGroupId });
    const before = revision();

    const response = await commit(
      id,
      commitBody({
        // A draft that collides with the item the list already has: it binds
        // that item, so nothing snapshot-visible was created.
        itemDrafts: [{ lineId: draftLineId, name: 'Milk' }],
      }),
    );

    expect(response.status).toBe(200);
    expect(receiptRow(id).status).toBe('committed');
    expect(lineRow(draftLineId)).toMatchObject({
      catalog_item_id: itemId,
      bound_via: 'manual',
    });
    expect(revision()).toBe(before);
  });

  it('never bumps the revision for a review edit', async () => {
    const { id, draftLineId } = insertReviewableReceipt();
    const before = revision();

    const response = await submit(
      patchRoute,
      new Request(`${origin}/api/receipts/${id}`, {
        method: 'PATCH',
        headers: { host, origin, 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedUpdatedAt: '2026-10-17T12:00:00.000Z',
          lines: [{ id: draftLineId, reviewState: 'skipped' }],
        }),
      }),
      { id },
    );

    expect(response.status).toBe(200);
    expect(lineRow(draftLineId).review_state).toBe('skipped');
    expect(revision()).toBe(before);
  });
});

describe('POST /api/receipts/[id]/discard', () => {
  it('purges the image, keeps the text and lines, and leaves the lists', async () => {
    const { id, imagePath, boundLineId } = insertReviewableReceipt({
      storeGroupId,
    });

    const response = await discard(id);

    expect(response.status).toBe(200);
    const detail = receiptDetailSchema.parse(await response.json());
    expect(detail.status).toBe('discarded');
    expect(detail.imageAvailable).toBe(false);
    // The OCR text and the parsed lines are the audit trail: still there.
    expect(detail.ocrText).toContain('MILK 2% 1L');
    expect(detail.lines).toHaveLength(4);
    expect(detail.lines.find((line) => line.id === boundLineId)).toMatchObject({
      catalogItemId: itemId,
      reviewState: 'bound',
    });

    expect(existsSync(join(storageDir, imagePath))).toBe(false);
    expect(receiptRow(id)).toMatchObject({
      status: 'discarded',
      image_path: null,
      image_bytes: null,
    });
    // The audit trail is every row, verbatim and in order — a discard destroys
    // the image and nothing else (ADR 0001).
    expect(
      query<{ raw_text: string }>(
        `SELECT raw_text FROM receipt_lines
          WHERE receipt_id = ?
          ORDER BY line_index, id`,
        id,
      ).map((row) => row.raw_text),
    ).toEqual(['MILK 2% 1L', 'SOURDOUGH BREAD', 'MYSTERY ITEM', 'SUBTOTAL']);

    // It leaves every list, and stays queryable by its own detail.
    const database = openDatabase();
    try {
      expect(listReceipts({}, database).items).toEqual([]);
      expect(getReceiptDetail(id, database).status).toBe('discarded');
    } finally {
      database.close();
    }
  });

  it('is idempotent: a second discard has nothing left to do', async () => {
    const { id } = insertReviewableReceipt();
    await discard(id);
    const first = receiptRow(id).updated_at;

    const response = await discard(id);

    expect(response.status).toBe(200);
    expect(receiptRow(id).updated_at).toBe(first);
  });

  it('discards a pending receipt too, and a failed one', async () => {
    for (const status of [
      'pending',
      'processing',
      'failed',
      'review',
    ] as const) {
      const { id } = insertReviewableReceipt({ status });

      const response = await discard(id);

      expect(response.status, status).toBe(200);
      expect(receiptRow(id).status, status).toBe('discarded');
    }
  });

  it('refuses to discard a committed receipt', async () => {
    const { id, draftLineId } = insertReviewableReceipt();
    await commit(
      id,
      commitBody({
        itemDrafts: [{ lineId: draftLineId, name: 'Sourdough loaf' }],
        storeDraft: 'Trader Joe’s',
      }),
    );

    const response = await discard(id);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'RECEIPT_COMMITTED' },
    });
    expect(receiptRow(id).status).toBe('committed');
  });

  it('reports an unknown receipt as missing', async () => {
    const response = await discard(randomUUID());

    expect(response.status).toBe(404);
  });

  it('lets the same bytes be uploaded again after the discard', async () => {
    const first = await upload();
    expect(first.status).toBe(201);
    const { id } = (await first.json()) as { id: string };
    // The dedupe holds while the receipt is alive: the same bytes come back as
    // already captured.
    expect((await upload()).status).toBe(200);

    expect((await discard(id)).status).toBe(200);

    const again = await upload();
    expect(again.status).toBe(201);
    expect(((await again.json()) as { id: string }).id).not.toBe(id);
    // The discarded row keeps its hash and its audit trail.
    const row = receiptRow(id);
    expect(row.status).toBe('discarded');
    expect(row.sha256).toHaveLength(64);
  });
});
