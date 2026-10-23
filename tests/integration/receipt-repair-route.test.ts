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
import { getServerInstanceId } from '../../src/lib/server/instance';
import { parseReceiptOcr } from '../../src/lib/server/receipts/parser';
import {
  listReceipts,
  writeReceiptParse,
} from '../../src/lib/server/services/receipts';
import { receiptDetailSchema } from '../../src/lib/shared/schemas';
import { POST as repairRoute } from '../../src/routes/api/receipts/[id]/repair/+server';

/**
 * Committed-receipt repair through the real route and a real database: the
 * binding moves, price history and aliases follow it, and everything raw —
 * printed text, OCR output, image, item names — stays exactly as committed
 * (ticket 16; `ADR 0003`).
 */

const origin = 'http://localhost:5173';
const host = new URL(origin).host;

let directory: string;
let storageDir: string;
let databasePath: string;
let listId: string;
let storeGroupId: string;
let milkItemId: string;
let breadItemId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'shopping-list-repair-'));
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
  listId = (
    database.prepare('SELECT id FROM lists LIMIT 1').get() as {
      id: string;
    }
  ).id;

  storeGroupId = randomUUID();
  database
    .prepare(
      `INSERT INTO groups (id, list_id, name, normalized_name, kind, position)
       VALUES (?, ?, 'Corner Market', 'corner market', 'store', 0)`,
    )
    .run(storeGroupId, listId);

  milkItemId = randomUUID();
  breadItemId = randomUUID();
  const insertItem = database.prepare(
    `INSERT INTO catalog_items (id, list_id, display_name, normalized_name)
     VALUES (?, ?, ?, ?)`,
  );
  insertItem.run(milkItemId, listId, 'Milk', 'milk');
  insertItem.run(breadItemId, listId, 'Sourdough Bread', 'sourdough bread');
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

function aliasRows(normalizedAlias: string): Row[] {
  return query<Row>(
    `SELECT id, catalog_item_id, alias_text, source, deleted_at,
            created_by_receipt_line_id
       FROM item_aliases
      WHERE normalized_alias = ?
      ORDER BY id`,
    normalizedAlias,
  );
}

/**
 * What one item's price history reads: its lines inside committed receipts.
 * The aggregate query is ticket 20's; what matters here is which item the stored
 * line counts for.
 */
function committedPrices(catalogItemId: string): Row[] {
  return query<Row>(
    `SELECT l.raw_text AS rawText, l.total_price_minor AS totalMinor
       FROM receipt_lines l
       JOIN receipts r ON r.id = l.receipt_id
      WHERE r.status = 'committed' AND l.catalog_item_id = ?
      ORDER BY r.created_at, l.line_index`,
    catalogItemId,
  );
}

/** A committed receipt: one line on Milk, one unknown line, one parked row. */
function insertCommittedReceipt(
  overrides: Record<string, unknown> = {},
  taughtAlias = true,
) {
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
            committed_at, created_at, updated_at)
         VALUES (@id, @listId, @status, @sha256, @imagePath, 18, 'USD',
                 349, NULL, 349, @ocrJson, @storeGroupId,
                 '2026-10-17T12:05:00.000Z', '2026-10-17T12:00:00.000Z',
                 @updatedAt)`,
      )
      .run({
        id,
        listId,
        status: 'committed',
        sha256: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
        imagePath,
        ocrJson: JSON.stringify({
          pages: [
            {
              lines: [
                { text: 'MILK 2% 1L' },
                { text: '3.49' },
                { text: 'MYSTERY ITEM' },
                { text: 'SUBTOTAL' },
              ],
            },
          ],
        }),
        storeGroupId,
        updatedAt: '2026-10-17T12:05:00.000Z',
        ...overrides,
      });

    const insertLine = database.prepare(
      `INSERT INTO receipt_lines
         (id, receipt_id, line_index, raw_text, parsed_name, quantity_real,
          quantity_text, quantity_unit, unit_price_minor, total_price_minor,
          is_item_chunk, confidence, review_state, catalog_item_id, bound_via,
          bound_rank, created_at, updated_at)
       VALUES (@id, @receiptId, @lineIndex, @rawText, @parsedName, NULL, NULL,
               NULL, NULL, @totalPriceMinor, @isItemChunk, 0.96, @reviewState,
               @catalogItemId, @boundVia, @boundRank,
               '2026-10-17T12:00:00.000Z', '2026-10-17T12:05:00.000Z')`,
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
      catalogItemId: milkItemId,
      boundVia: 'manual',
      boundRank: null,
    });
    const unknownLineId = randomUUID();
    insertLine.run({
      id: unknownLineId,
      receiptId: id,
      lineIndex: 1,
      rawText: 'MYSTERY ITEM',
      parsedName: 'MYSTERY ITEM',
      totalPriceMinor: 100,
      isItemChunk: 1,
      reviewState: 'unknown',
      catalogItemId: null,
      boundVia: null,
      boundRank: null,
    });
    const parkedLineId = randomUUID();
    insertLine.run({
      id: parkedLineId,
      receiptId: id,
      lineIndex: 2,
      rawText: 'SUBTOTAL',
      parsedName: null,
      totalPriceMinor: 349,
      isItemChunk: 0,
      reviewState: 'unreviewed',
      catalogItemId: null,
      boundVia: null,
      boundRank: null,
    });

    // What the commit learned: this line's printed text, for the item it bound.
    // A second commit of the same wording learns nothing new, so a receipt built
    // on top of another one simply finds the row already there.
    const liveAlias = database
      .prepare(
        `SELECT id FROM item_aliases
          WHERE list_id = ? AND catalog_item_id = ? AND normalized_alias = 'milk 2% 1l'
            AND deleted_at IS NULL`,
      )
      .get(listId, milkItemId);
    if (taughtAlias && !liveAlias) {
      database
        .prepare(
          `INSERT INTO item_aliases
             (id, list_id, catalog_item_id, alias_text, normalized_alias, source,
              created_by_receipt_line_id)
           VALUES (?, ?, ?, 'MILK 2% 1L', 'milk 2% 1l', 'review', ?)`,
        )
        .run(randomUUID(), listId, milkItemId, boundLineId);
    }

    return { id, imagePath, boundLineId, unknownLineId, parkedLineId };
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
  const event = { request, url: new URL(request.url), params };
  return handle({
    event,
    resolve: async () => route(event as never),
  } as never);
}

function repair(id: string, body: unknown): Promise<Response> {
  const requestBody =
    body && typeof body === 'object' && !Array.isArray(body)
      ? { serverInstanceId: getServerInstanceId(), ...body }
      : body;
  return submit(
    repairRoute,
    new Request(`${origin}/api/receipts/${id}/repair`, {
      method: 'POST',
      headers: { host, origin, 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    }),
    { id },
  );
}

const COMMITTED_AT = '2026-10-17T12:05:00.000Z';

function repairBody(overrides: Record<string, unknown> = {}) {
  return { expectedUpdatedAt: COMMITTED_AT, ...overrides };
}

describe('POST /api/receipts/[id]/repair — the correction', () => {
  it('moves one line’s binding, and price history and aliases follow it', async () => {
    const { id, boundLineId, imagePath } = insertCommittedReceipt();
    const ocrJson = receiptRow(id).ocr_json;
    const before = revision();

    const response = await repair(
      id,
      repairBody({
        lines: [
          {
            id: boundLineId,
            reviewState: 'bound',
            catalogItemId: breadItemId,
          },
        ],
      }),
    );

    expect(response.status).toBe(200);
    const detail = receiptDetailSchema.parse(await response.json());
    expect(detail.status).toBe('committed');
    expect(detail.committedAt).toBe(COMMITTED_AT);
    expect(detail.updatedAt).not.toBe(COMMITTED_AT);

    // The binding is the correction: the new item, the reviewer's own hand, no
    // accepted-suggestion rank.
    expect(lineRow(boundLineId)).toMatchObject({
      catalog_item_id: breadItemId,
      review_state: 'bound',
      bound_via: 'manual',
      bound_rank: null,
    });

    // Price history reads committed lines, so the fix moves the price with it.
    expect(committedPrices(breadItemId)).toEqual([
      { rawText: 'MILK 2% 1L', totalMinor: 349 },
    ]);
    expect(committedPrices(milkItemId)).toEqual([]);

    // The household's terms are never rewritten by a receipt correction.
    expect(
      one<{ display_name: string }>(
        'SELECT display_name FROM catalog_items WHERE id = ?',
        milkItemId,
      ).display_name,
    ).toBe('Milk');
    expect(
      one<{ display_name: string }>(
        'SELECT display_name FROM catalog_items WHERE id = ?',
        breadItemId,
      ).display_name,
    ).toBe('Sourdough Bread');

    // Raw artifacts are untouched: the printed text, the OCR output, the image.
    expect(lineRow(boundLineId).raw_text).toBe('MILK 2% 1L');
    expect(receiptRow(id).ocr_json).toBe(ocrJson);
    expect(receiptRow(id).image_path).toBe(imagePath);
    expect(existsSync(join(storageDir, imagePath))).toBe(true);
    expect(detail.imageAvailable).toBe(true);

    // A repair creates nothing the snapshot carries.
    expect(revision()).toBe(before);
  });

  it('retracts the alias this line taught and teaches the new binding', async () => {
    const { id, boundLineId } = insertCommittedReceipt();

    const response = await repair(
      id,
      repairBody({
        lines: [
          { id: boundLineId, reviewState: 'bound', catalogItemId: breadItemId },
        ],
      }),
    );
    expect(response.status).toBe(200);

    const aliases = aliasRows('milk 2% 1l');
    expect(aliases).toHaveLength(2);
    // The wording no longer means Milk: its row is soft-deleted, kept for audit.
    expect(
      aliases.find((alias) => alias.catalog_item_id === milkItemId),
    ).toMatchObject({
      deleted_at: expect.any(String),
      created_by_receipt_line_id: boundLineId,
    });
    // …and it now means Sourdough Bread, learned the way a commit learns one.
    expect(
      aliases.find((alias) => alias.catalog_item_id === breadItemId),
    ).toMatchObject({ deleted_at: null, source: 'review' });
  });

  it('binds the next receipt straight from the relearned wording', async () => {
    const { id, boundLineId } = insertCommittedReceipt();
    await repair(
      id,
      repairBody({
        lines: [
          { id: boundLineId, reviewState: 'bound', catalogItemId: breadItemId },
        ],
      }),
    );

    // A second receipt prints the same wording; the worker's parse binds it.
    const next = insertCommittedReceipt({ status: 'review' }, false);
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
                    text: 'MILK 2% 1L',
                    conf: 0.97,
                  },
                  { box: [380, 124, 452, 140], text: '3.49', conf: 0.98 },
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
      "SELECT * FROM receipt_lines WHERE receipt_id = ? AND raw_text = 'MILK 2% 1L'",
      next.id,
    );
    expect(line).toMatchObject({
      catalog_item_id: breadItemId,
      review_state: 'bound',
      bound_via: 'auto',
      bound_rank: null,
    });
  });

  it('leaves an alias another line or a human confirmed in place', async () => {
    const { id, boundLineId } = insertCommittedReceipt();
    const database = openDatabase();
    try {
      // This receipt's line taught nothing: the wording was confirmed by hand.
      database
        .prepare(
          'DELETE FROM item_aliases WHERE created_by_receipt_line_id IS NOT NULL',
        )
        .run();
      database
        .prepare(
          `INSERT INTO item_aliases
             (id, list_id, catalog_item_id, alias_text, normalized_alias, source,
              created_by_receipt_line_id)
           VALUES (?, ?, ?, 'MILK 2% 1L', 'milk 2% 1l', 'manual', NULL)`,
        )
        .run(randomUUID(), listId, milkItemId);
    } finally {
      database.close();
    }

    await repair(
      id,
      repairBody({
        lines: [
          { id: boundLineId, reviewState: 'bound', catalogItemId: breadItemId },
        ],
      }),
    );

    // The hand-confirmed row survives; it is the alias surface's to delete. Two
    // items claiming the wording now means matching asks, never guesses.
    const manual = aliasRows('milk 2% 1l').find(
      (alias) => alias.source === 'manual',
    );
    expect(manual).toMatchObject({
      catalog_item_id: milkItemId,
      deleted_at: null,
    });
  });

  it('binds a line the reviewer could not identify, dropping the receipt from the unknowns', async () => {
    const { id, unknownLineId } = insertCommittedReceipt();
    const database = openDatabase();
    try {
      expect(
        listReceipts({ hasUnknowns: 'true' }, database).items.map(
          (item) => item.id,
        ),
      ).toEqual([id]);
    } finally {
      database.close();
    }

    const response = await repair(
      id,
      repairBody({
        lines: [
          {
            id: unknownLineId,
            reviewState: 'bound',
            catalogItemId: milkItemId,
          },
        ],
      }),
    );

    expect(response.status).toBe(200);
    expect(lineRow(unknownLineId)).toMatchObject({
      catalog_item_id: milkItemId,
      review_state: 'bound',
      bound_via: 'manual',
      bound_rank: null,
    });
    // Its price is now this item's observation.
    expect(committedPrices(milkItemId)).toEqual([
      { rawText: 'MILK 2% 1L', totalMinor: 349 },
      { rawText: 'MYSTERY ITEM', totalMinor: 100 },
    ]);

    const after = openDatabase();
    try {
      expect(listReceipts({ hasUnknowns: 'true' }, after).items).toEqual([]);
      expect(listReceipts({}, after).items[0]).toMatchObject({
        id,
        hasUnknowns: false,
      });
    } finally {
      after.close();
    }
  });

  it('releases a bound line, keeping its price as unidentified spending', async () => {
    const { id, boundLineId } = insertCommittedReceipt();

    const response = await repair(
      id,
      repairBody({ lines: [{ id: boundLineId, reviewState: 'unknown' }] }),
    );

    expect(response.status).toBe(200);
    expect(lineRow(boundLineId)).toMatchObject({
      catalog_item_id: null,
      review_state: 'unknown',
      bound_via: null,
      bound_rank: null,
    });
    // The line is retained with its price — capture-first — but no longer counts
    // for an item.
    expect(committedPrices(milkItemId)).toEqual([]);
    expect(committedPrices(breadItemId)).toEqual([]);
    // The wording it taught stops binding, so no later receipt is bound on it.
    expect(aliasRows('milk 2% 1l')[0]).toMatchObject({
      catalog_item_id: milkItemId,
      deleted_at: expect.any(String),
    });
    // The row is still there, and the receipt is listed as holding an unknown.
    const database = openDatabase();
    try {
      expect(listReceipts({}, database).items[0]).toMatchObject({
        id,
        hasUnknowns: true,
      });
    } finally {
      database.close();
    }
  });
});

describe('POST /api/receipts/[id]/repair — the refusals', () => {
  it('refuses every status that is not committed, writing nothing', async () => {
    for (const status of [
      'pending',
      'processing',
      'review',
      'discarded',
    ] as const) {
      const { id, boundLineId } = insertCommittedReceipt({ status });
      const before = receiptRow(id).updated_at;
      const beforeRevision = revision();

      const response = await repair(
        id,
        repairBody({
          lines: [
            {
              id: boundLineId,
              reviewState: 'bound',
              catalogItemId: breadItemId,
            },
          ],
        }),
      );

      expect(response.status, status).toBe(409);
      expect(await response.json(), status).toMatchObject({
        error: { code: 'RECEIPT_NOT_COMMITTED' },
      });
      expect(receiptRow(id).updated_at, status).toBe(before);
      expect(lineRow(boundLineId).catalog_item_id, status).toBe(milkItemId);
      expect(aliasRows('milk 2% 1l'), status).toHaveLength(1);
      expect(revision(), status).toBe(beforeRevision);
    }
  });

  it('refuses a repair from a stale view', async () => {
    const { id, boundLineId } = insertCommittedReceipt();

    const response = await repair(id, {
      expectedUpdatedAt: '2026-10-17T12:04:00.000Z',
      lines: [
        { id: boundLineId, reviewState: 'bound', catalogItemId: breadItemId },
      ],
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'RECEIPT_CHANGED' },
    });
    expect(lineRow(boundLineId).catalog_item_id).toBe(milkItemId);
  });

  it('refuses a repair from a different server instance before writing', async () => {
    const { id, boundLineId } = insertCommittedReceipt();
    const beforeReceipt = receiptRow(id);
    const beforeLine = lineRow(boundLineId);
    const beforeRevision = revision();

    const response = await repair(
      id,
      repairBody({
        serverInstanceId: randomUUID(),
        lines: [
          { id: boundLineId, reviewState: 'bound', catalogItemId: breadItemId },
        ],
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'SERVER_CHANGED' },
    });
    expect(receiptRow(id)).toEqual(beforeReceipt);
    expect(lineRow(boundLineId)).toEqual(beforeLine);
    expect(revision()).toBe(beforeRevision);
  });

  it('refuses a parked row: a repair corrects a binding, not a parser row', async () => {
    const { id, parkedLineId } = insertCommittedReceipt();

    const response = await repair(
      id,
      repairBody({
        lines: [
          {
            id: parkedLineId,
            reviewState: 'bound',
            catalogItemId: breadItemId,
          },
        ],
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'INVALID_LINE' },
    });
    expect(lineRow(parkedLineId)).toMatchObject({
      review_state: 'unreviewed',
      catalog_item_id: null,
    });
  });

  it('refuses a line that belongs to another receipt', async () => {
    const { id } = insertCommittedReceipt();
    const other = insertCommittedReceipt({}, false);

    const response = await repair(
      id,
      repairBody({
        lines: [
          {
            id: other.boundLineId,
            reviewState: 'bound',
            catalogItemId: breadItemId,
          },
        ],
      }),
    );

    expect(response.status).toBe(400);
    expect(lineRow(other.boundLineId).catalog_item_id).toBe(milkItemId);
  });

  it('refuses an item this list does not have', async () => {
    const { id, boundLineId } = insertCommittedReceipt();

    const response = await repair(
      id,
      repairBody({
        lines: [
          {
            id: boundLineId,
            reviewState: 'bound',
            catalogItemId: randomUUID(),
          },
        ],
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'INVALID_ITEM' },
    });
    expect(lineRow(boundLineId).catalog_item_id).toBe(milkItemId);
  });

  it('refuses to hand a committed line back to the review queue', async () => {
    const { id, boundLineId } = insertCommittedReceipt();

    for (const reviewState of ['unreviewed', 'new']) {
      const response = await repair(
        id,
        repairBody({ lines: [{ id: boundLineId, reviewState }] }),
      );

      expect(response.status, reviewState).toBe(400);
      expect(await response.json(), reviewState).toMatchObject({
        error: { code: 'VALIDATION_ERROR' },
      });
    }
    expect(lineRow(boundLineId)).toMatchObject({
      review_state: 'bound',
      catalog_item_id: milkItemId,
    });
  });

  it('refuses a repair that names nothing to correct', async () => {
    const { id } = insertCommittedReceipt();

    for (const lines of [[], [{ id: randomUUID() }]]) {
      const response = await repair(id, repairBody({ lines }));

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: 'VALIDATION_ERROR' },
      });
    }
  });

  it('refuses fields a repair does not own — the raw artifacts stay committed', async () => {
    const { id, boundLineId } = insertCommittedReceipt();

    const response = await repair(
      id,
      repairBody({
        lines: [
          {
            id: boundLineId,
            rawText: 'MILK 2% 2L',
            catalogItemId: breadItemId,
          },
        ],
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR' },
    });
    expect(lineRow(boundLineId).raw_text).toBe('MILK 2% 1L');
  });

  it('refuses provenance a repair cannot claim', async () => {
    const { id, boundLineId } = insertCommittedReceipt();

    for (const boundVia of ['auto', 'created']) {
      const response = await repair(
        id,
        repairBody({
          lines: [{ id: boundLineId, catalogItemId: breadItemId, boundVia }],
        }),
      );

      expect(response.status, boundVia).toBe(400);
      expect(await response.json(), boundVia).toMatchObject({
        error: { code: 'VALIDATION_ERROR' },
      });
    }
    // A rejected patch writes nothing: the line still holds the commit's own
    // provenance, and a hand correction that names none is a `manual` bind.
    expect(lineRow(boundLineId)).toMatchObject({
      catalog_item_id: milkItemId,
      bound_via: 'manual',
    });
  });

  it('reports an unknown receipt as missing', async () => {
    const response = await repair(
      randomUUID(),
      repairBody({ lines: [{ id: randomUUID(), reviewState: 'unknown' }] }),
    );

    expect(response.status).toBe(404);
  });
});
