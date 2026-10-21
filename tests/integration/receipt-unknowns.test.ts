import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handle } from '../../src/hooks.server';
import { closeDatabase } from '../../src/lib/server/db/connection';
import { migrateAndBootstrap } from '../../src/lib/server/db/lifecycle.js';
import { openSqliteDatabase } from '../../src/lib/server/db/sqlite.js';
import type { ParsedReceipt } from '../../src/lib/server/receipts/parser';
import {
  getReceiptDetail,
  writeReceiptParse,
} from '../../src/lib/server/services/receipts';
import {
  unknownLinesBindResultSchema,
  unknownLinesOverviewSchema,
} from '../../src/lib/shared/schemas';
import { GET as unknownLinesRoute } from '../../src/routes/api/unknown-lines/+server';
import { POST as bindRoute } from '../../src/routes/api/unknown-lines/bind/+server';

/**
 * The grouped unknown-line browser through the real routes and a real database
 * (ticket 17): groups derive from normalized printed text across committed
 * receipts, their counts and spend are the unidentified-spending view, and one
 * batch bind moves every constituent line and teaches the alias the next
 * receipt auto-binds.
 */

const origin = 'http://localhost:5173';
const host = new URL(origin).host;

let directory: string;
let databasePath: string;
let listId: string;
let storeGroupId: string;
let milkId: string;
let breadId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'shopping-list-unknowns-'));
  const storageDir = join(directory, 'receipts');
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
    database.prepare('SELECT id FROM lists LIMIT 1').get() as { id: string }
  ).id;
  storeGroupId = randomUUID();
  database
    .prepare(
      `INSERT INTO groups (id, list_id, name, normalized_name, kind, position)
       VALUES (?, ?, 'Corner Market', 'corner market', 'store', 0)`,
    )
    .run(storeGroupId, listId);

  milkId = randomUUID();
  breadId = randomUUID();
  const insertItem = database.prepare(
    `INSERT INTO catalog_items (id, list_id, display_name, normalized_name)
     VALUES (?, ?, ?, ?)`,
  );
  insertItem.run(milkId, listId, 'Milk', 'milk');
  insertItem.run(breadId, listId, 'Sourdough Bread', 'sourdough bread');
  database.close();
});

afterEach(() => {
  closeDatabase();
  rmSync(directory, { recursive: true, force: true });
  delete process.env.RECEIPT_CURRENCY;
});

type Row = Record<string, unknown>;
type Database = ReturnType<typeof openSqliteDatabase>;

function openDatabase(): Database {
  return openSqliteDatabase(databasePath);
}

function one<T extends Row>(sql: string, ...parameters: unknown[]): T {
  const database = openDatabase();
  try {
    const rows = database.prepare(sql).all(...parameters) as T[];
    expect(rows, sql).toHaveLength(1);
    return rows[0]!;
  } finally {
    database.close();
  }
}

function useDatabase<T>(callback: (database: Database) => T): T {
  const database = openDatabase();
  try {
    return callback(database);
  } finally {
    database.close();
  }
}

/** Add one item to this list, the way a commit materializing a draft would. */
function addItem(name: string): string {
  const id = randomUUID();
  useDatabase((database) =>
    database
      .prepare(
        `INSERT INTO catalog_items (id, list_id, display_name, normalized_name)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, listId, name, name.toLowerCase()),
  );
  return id;
}

/** One receipt row; a committed receipt always carries the store the schema requires. */
function insertReceipt(
  options: {
    status?: 'review' | 'committed' | 'discarded';
    committedAt?: string;
    listId?: string;
    storeGroupId?: string | null;
  } = {},
): string {
  const id = randomUUID();
  const status = options.status ?? 'committed';
  const targetListId = options.listId ?? listId;
  const store =
    options.storeGroupId === undefined
      ? status === 'committed'
        ? storeGroupId
        : null
      : options.storeGroupId;
  useDatabase((database) =>
    database
      .prepare(
        `INSERT INTO receipts
           (id, list_id, status, sha256, currency, store_group_id, committed_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, 'USD', ?, ?, '2026-10-17T12:00:00.000Z',
                 '2026-10-17T12:00:00.000Z')`,
      )
      .run(
        id,
        targetListId,
        status,
        randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
        store,
        options.committedAt ?? '2026-10-17T12:00:00.000Z',
      ),
  );
  return id;
}

function insertLine(
  receiptId: string,
  options: {
    rawText: string;
    totalPriceMinor?: number | null;
    quantityReal?: number | null;
    unitPriceMinor?: number | null;
    reviewState?: 'unknown' | 'skipped' | 'bound' | 'unreviewed';
    isItemChunk?: boolean;
    lineIndex?: number;
    catalogItemId?: string | null;
  },
): string {
  const id = randomUUID();
  const database = openDatabase();
  try {
    database
      .prepare(
        `INSERT INTO receipt_lines
           (id, receipt_id, line_index, raw_text, is_item_chunk, total_price_minor,
            quantity_real, unit_price_minor, catalog_item_id, review_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        receiptId,
        options.lineIndex ?? 0,
        options.rawText,
        (options.isItemChunk ?? true) ? 1 : 0,
        options.totalPriceMinor ?? null,
        options.quantityReal ?? null,
        options.unitPriceMinor ?? null,
        options.catalogItemId ?? null,
        options.reviewState ?? 'unknown',
      );
  } finally {
    database.close();
  }
  return id;
}

function revision(): number {
  return one<{ revision: number }>(
    'SELECT revision FROM app_state WHERE id = 1',
  ).revision;
}

function receiptUpdatedAt(receiptId: string): string {
  return one<{ updated_at: string }>(
    'SELECT updated_at FROM receipts WHERE id = ?',
    receiptId,
  ).updated_at;
}

async function submit(
  route: (event: never) => Response | Promise<Response>,
  request: Request,
): Promise<Response> {
  const event = { request, url: new URL(request.url), params: {} };
  return handle({
    event,
    resolve: async () => route(event as never),
  } as never);
}

async function overview(): Promise<
  ReturnType<typeof unknownLinesOverviewSchema.parse>
> {
  const response = await submit(
    unknownLinesRoute,
    new Request(`${origin}/api/unknown-lines`, { headers: { host, origin } }),
  );
  expect(response.status).toBe(200);
  return unknownLinesOverviewSchema.parse(await response.json());
}

function bind(
  normalizedText: string,
  catalogItemId: string,
): Promise<Response> {
  return submit(
    bindRoute,
    new Request(`${origin}/api/unknown-lines/bind`, {
      method: 'POST',
      headers: { host, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ normalizedText, catalogItemId }),
    }),
  );
}

/** One parsed item line, the way the worker hands a parse to the service. */
function parsedReceipt(rawText: string): ParsedReceipt {
  return {
    parseVersion: 1,
    lines: [
      {
        sourceLineIndexes: [0],
        rawText,
        parsedName: rawText,
        quantityReal: null,
        quantityText: null,
        quantityUnit: null,
        unitPriceMinor: null,
        totalPriceMinor: 349,
        isItemChunk: true,
        confidence: 0.96,
      },
    ],
    subtotalMinor: null,
    taxMinor: null,
    totalMinor: 349,
    deltaMinor: null,
    warnings: [],
  };
}

/** Parse one line onto a fresh review receipt, i.e. what the worker's tick writes. */
function parseLine(rawText: string): string {
  const receiptId = insertReceipt({ status: 'review' });
  useDatabase((database) =>
    writeReceiptParse(database, receiptId, parsedReceipt(rawText), 'USD'),
  );
  return receiptId;
}

describe('GET /api/unknown-lines', () => {
  it('groups unknown item lines by normalized printed text across committed receipts', async () => {
    const oldReceipt = insertReceipt({
      committedAt: '2026-10-16T12:00:00.000Z',
    });
    const newReceipt = insertReceipt({
      committedAt: '2026-10-18T12:00:00.000Z',
    });

    insertLine(oldReceipt, {
      rawText: 'MYSTERY ITEM',
      totalPriceMinor: 349,
      lineIndex: 0,
    });
    insertLine(oldReceipt, {
      rawText: 'mystery item',
      totalPriceMinor: 250,
      lineIndex: 1,
    });
    insertLine(newReceipt, {
      rawText: ' MYSTERY ITEM ',
      totalPriceMinor: 101,
      lineIndex: 0,
    });
    insertLine(oldReceipt, {
      rawText: 'MYSTERY ITEM',
      totalPriceMinor: 999,
      reviewState: 'skipped',
      lineIndex: 2,
    });
    insertLine(oldReceipt, {
      rawText: 'MYSTERY ITEM',
      totalPriceMinor: 500,
      isItemChunk: false,
      lineIndex: 3,
    });
    insertLine(newReceipt, {
      rawText: 'OTHER THING',
      totalPriceMinor: 500,
      lineIndex: 1,
    });

    const body = await overview();

    expect(body.currency).toBe('USD');
    expect(body.groups).toEqual([
      {
        normalizedText: 'mystery item',
        printedText: 'MYSTERY ITEM',
        lineCount: 3,
        receiptCount: 2,
        spendMinor: 700,
      },
      {
        normalizedText: 'other thing',
        printedText: 'OTHER THING',
        lineCount: 1,
        receiptCount: 1,
        spendMinor: 500,
      },
    ]);
    expect(body.lineCount).toBe(4);
    expect(body.spendMinor).toBe(1200);
  });

  it('reads only committed receipts of this list', async () => {
    const reviewReceipt = insertReceipt({ status: 'review' });
    insertLine(reviewReceipt, { rawText: 'NOT COMMITTED' });
    const discarded = insertReceipt({ status: 'discarded' });
    insertLine(discarded, { rawText: 'DISCARDED' });
    const committed = insertReceipt();
    insertLine(committed, { rawText: 'COMMITTED' });

    useDatabase((database) => {
      const otherListId = randomUUID();
      database
        .prepare('INSERT INTO lists (id, name) VALUES (?, ?)')
        .run(otherListId, 'Someone else');
      const otherStore = randomUUID();
      database
        .prepare(
          `INSERT INTO groups (id, list_id, name, normalized_name, kind, position)
           VALUES (?, ?, 'Other Market', 'other market', 'store', 0)`,
        )
        .run(otherStore, otherListId);
      const otherReceipt = randomUUID();
      database
        .prepare(
          `INSERT INTO receipts
             (id, list_id, status, sha256, currency, store_group_id, committed_at)
           VALUES (?, ?, 'committed', ?, 'USD', ?, '2026-10-18T12:00:00.000Z')`,
        )
        .run(otherReceipt, otherListId, 'a'.repeat(64), otherStore);
      database
        .prepare(
          `INSERT INTO receipt_lines
             (id, receipt_id, line_index, raw_text, is_item_chunk, review_state)
           VALUES (?, ?, 0, 'FOREIGN', 1, 'unknown')`,
        )
        .run(randomUUID(), otherReceipt);
    });

    const body = await overview();

    expect(body.groups.map((group) => group.normalizedText)).toEqual([
      'committed',
    ]);
  });

  it('answers an empty, zero-spend view when nothing is unknown', async () => {
    const committed = insertReceipt();
    insertLine(committed, {
      rawText: 'BREAD',
      reviewState: 'bound',
      catalogItemId: breadId,
    });

    expect(await overview()).toEqual({
      currency: 'USD',
      groups: [],
      lineCount: 0,
      spendMinor: 0,
    });
  });

  it('counts a line with no printed wording and prices a unit-only line', async () => {
    const receipt = insertReceipt();
    insertLine(receipt, {
      rawText: '   ',
      totalPriceMinor: 125,
      lineIndex: 0,
    });
    insertLine(receipt, {
      rawText: 'TWO AT',
      quantityReal: 2,
      unitPriceMinor: 150,
      lineIndex: 1,
    });

    expect(await overview()).toMatchObject({
      lineCount: 2,
      spendMinor: 425,
      groups: [
        {
          normalizedText: 'two at',
          printedText: 'TWO AT',
          lineCount: 1,
          receiptCount: 1,
          spendMinor: 300,
        },
        {
          normalizedText: '',
          printedText: '',
          lineCount: 1,
          receiptCount: 1,
          spendMinor: 125,
        },
      ],
    });
  });
});

describe('POST /api/unknown-lines/bind', () => {
  it('binds every constituent line across receipts and learns the alias', async () => {
    const oldReceipt = insertReceipt({
      committedAt: '2026-10-16T12:00:00.000Z',
    });
    const newReceipt = insertReceipt({
      committedAt: '2026-10-18T12:00:00.000Z',
    });
    const untouchedReceipt = insertReceipt({
      committedAt: '2026-10-15T12:00:00.000Z',
    });
    const oldLine = insertLine(oldReceipt, {
      rawText: 'MYSTERY ITEM',
      totalPriceMinor: 349,
      lineIndex: 0,
    });
    const otherLine = insertLine(oldReceipt, {
      rawText: 'OTHER THING',
      totalPriceMinor: 500,
      lineIndex: 1,
    });
    const newLine = insertLine(newReceipt, {
      rawText: 'Mystery Item',
      totalPriceMinor: 250,
      lineIndex: 0,
    });
    insertLine(untouchedReceipt, {
      rawText: 'UNTOUCHED',
      totalPriceMinor: 100,
    });

    const beforeRevision = revision();
    const beforeNew = receiptUpdatedAt(newReceipt);
    const beforeUntouched = receiptUpdatedAt(untouchedReceipt);

    const response = await bind('  mystery   item  ', milkId);

    expect(response.status).toBe(200);
    const result = unknownLinesBindResultSchema.parse(await response.json());
    expect(result.boundLineCount).toBe(2);
    expect(result.overview.groups.map((group) => group.normalizedText)).toEqual(
      ['other thing', 'untouched'],
    );

    // Every constituent line carries the pick, with the provenance a manual
    // repair records; the one-off lines and raw artifacts are untouched.
    for (const lineId of [oldLine, newLine]) {
      expect(
        one<Row>(
          `SELECT review_state, catalog_item_id, bound_via, bound_rank,
                  raw_text, total_price_minor
             FROM receipt_lines WHERE id = ?`,
          lineId,
        ),
      ).toMatchObject({
        review_state: 'bound',
        catalog_item_id: milkId,
        bound_via: 'manual',
        bound_rank: null,
      });
    }
    expect(
      one<Row>(
        'SELECT review_state, catalog_item_id FROM receipt_lines WHERE id = ?',
        otherLine,
      ),
    ).toMatchObject({ review_state: 'unknown', catalog_item_id: null });

    // The most recent printing teaches the alias, at review confidence.
    const alias = one<Row>(
      `SELECT alias_text, normalized_alias, source,
              created_by_receipt_line_id, deleted_at
         FROM item_aliases WHERE list_id = ? AND catalog_item_id = ?`,
      listId,
      milkId,
    );
    expect(alias).toMatchObject({
      alias_text: 'Mystery Item',
      normalized_alias: 'mystery item',
      source: 'review',
      created_by_receipt_line_id: newLine,
      deleted_at: null,
    });

    // A receipt's `updated_at` is its guard token, so the receipts whose lines
    // moved carry a new one; a receipt the bind did not touch keeps its own.
    expect(receiptUpdatedAt(newReceipt)).not.toBe(beforeNew);
    expect(receiptUpdatedAt(untouchedReceipt)).toBe(beforeUntouched);
    // Receipts and aliases stay out of the snapshot.
    expect(revision()).toBe(beforeRevision);

    // The whole point of the alias: the next receipt printing the wording binds
    // by itself, with no reviewer tap.
    const nextReceipt = parseLine('MYSTERY ITEM');
    const line = getReceiptDetail(nextReceipt).lines[0]!;
    expect(line).toMatchObject({
      catalogItemId: milkId,
      reviewState: 'bound',
      boundVia: 'auto',
    });
  });

  it('binds only what is still unknown, and reports what actually moved', async () => {
    const receipt = insertReceipt();
    const line = insertLine(receipt, {
      rawText: 'MYSTERY ITEM',
      reviewState: 'unknown',
    });
    // Another device repaired the line between the view and the tap.
    useDatabase((database) =>
      database
        .prepare(
          "UPDATE receipt_lines SET review_state = 'bound', catalog_item_id = ?, bound_via = 'manual' WHERE id = ?",
        )
        .run(breadId, line),
    );

    const response = await bind('MYSTERY ITEM', milkId);

    expect(response.status).toBe(404);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe('NOT_FOUND');
    expect(
      one<Row>(
        'SELECT catalog_item_id, bound_via FROM receipt_lines WHERE id = ?',
        line,
      ),
    ).toMatchObject({ catalog_item_id: breadId, bound_via: 'manual' });
    expect(
      one<{ count: number }>('SELECT COUNT(*) AS count FROM item_aliases')
        .count,
    ).toBe(0);
  });

  it('refuses an item that is not in this list, writing nothing', async () => {
    const receipt = insertReceipt();
    const line = insertLine(receipt, {
      rawText: 'MYSTERY ITEM',
      totalPriceMinor: 349,
    });

    const response = await bind('MYSTERY ITEM', randomUUID());

    expect(response.status).toBe(400);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe('INVALID_ITEM');
    expect(
      one<Row>(
        'SELECT review_state, catalog_item_id FROM receipt_lines WHERE id = ?',
        line,
      ),
    ).toMatchObject({ review_state: 'unknown', catalog_item_id: null });
    expect(
      one<{ count: number }>('SELECT COUNT(*) AS count FROM item_aliases')
        .count,
    ).toBe(0);
  });

  it('cannot bind a group from another list', async () => {
    let foreignLine: string;
    useDatabase((database) => {
      const otherListId = randomUUID();
      database
        .prepare('INSERT INTO lists (id, name) VALUES (?, ?)')
        .run(otherListId, 'Someone else');
      const otherStore = randomUUID();
      database
        .prepare(
          `INSERT INTO groups (id, list_id, name, normalized_name, kind, position)
           VALUES (?, ?, 'Other Market', 'other market', 'store', 0)`,
        )
        .run(otherStore, otherListId);
      const otherReceipt = randomUUID();
      database
        .prepare(
          `INSERT INTO receipts
             (id, list_id, status, sha256, currency, store_group_id, committed_at)
           VALUES (?, ?, 'committed', ?, 'USD', ?, '2026-10-18T12:00:00.000Z')`,
        )
        .run(otherReceipt, otherListId, 'b'.repeat(64), otherStore);
      foreignLine = randomUUID();
      database
        .prepare(
          `INSERT INTO receipt_lines
             (id, receipt_id, line_index, raw_text, is_item_chunk, review_state)
           VALUES (?, ?, 0, 'FOREIGN MYSTERY', 1, 'unknown')`,
        )
        .run(foreignLine, otherReceipt);
    });

    const response = await bind('FOREIGN MYSTERY', milkId);

    expect(response.status).toBe(404);
    expect(
      one<{ review_state: string }>(
        'SELECT review_state FROM receipt_lines WHERE id = ?',
        foreignLine!,
      ).review_state,
    ).toBe('unknown');
  });

  it('binds a group with no printed wording without learning an empty alias', async () => {
    const receipt = insertReceipt();
    const line = insertLine(receipt, { rawText: '  ', totalPriceMinor: 125 });

    const response = await bind('', milkId);

    expect(response.status).toBe(200);
    const result = unknownLinesBindResultSchema.parse(await response.json());
    expect(result.boundLineCount).toBe(1);
    expect(result.overview.groups).toEqual([]);
    expect(
      one<Row>(
        'SELECT review_state, catalog_item_id, bound_via FROM receipt_lines WHERE id = ?',
        line,
      ),
    ).toMatchObject({
      review_state: 'bound',
      catalog_item_id: milkId,
      bound_via: 'manual',
    });
    expect(
      one<{ count: number }>('SELECT COUNT(*) AS count FROM item_aliases')
        .count,
    ).toBe(0);
  });

  it('keeps a conflicting phrase, so matching asks on the next receipt', async () => {
    const otherItem = addItem('Buttermilk');
    useDatabase((database) =>
      database
        .prepare(
          `INSERT INTO item_aliases
             (id, list_id, catalog_item_id, alias_text, normalized_alias, source)
           VALUES (?, ?, ?, 'MYSTERY ITEM', 'mystery item', 'review')`,
        )
        .run(randomUUID(), listId, otherItem),
    );
    const receipt = insertReceipt();
    insertLine(receipt, { rawText: 'MYSTERY ITEM', totalPriceMinor: 349 });

    const response = await bind('MYSTERY ITEM', milkId);
    expect(response.status).toBe(200);

    // Both claims are live: ADR 0003 keeps conflicts instead of retargeting.
    const aliases = useDatabase(
      (database) =>
        database
          .prepare(
            'SELECT catalog_item_id FROM item_aliases WHERE normalized_alias = ? AND deleted_at IS NULL',
          )
          .all('mystery item') as { catalog_item_id: string }[],
    );
    expect(aliases.map((alias) => alias.catalog_item_id).sort()).toEqual(
      [milkId, otherItem].sort(),
    );

    // The next receipt is therefore left for the reviewer, with both tier-1
    // candidates offered rather than a silent pick.
    const detail = getReceiptDetail(parseLine('MYSTERY ITEM'));
    expect(detail.lines[0]).toMatchObject({
      catalogItemId: null,
      reviewState: 'unreviewed',
    });
    expect(
      detail.lines[0]!.suggestions.map((suggestion) => [
        suggestion.name,
        suggestion.tier,
      ]),
    ).toEqual([
      ['Buttermilk', 1],
      ['Milk', 1],
    ]);
  });
});
