import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/lib/server/db/connection';
import { migrateAndBootstrap } from '../../src/lib/server/db/lifecycle.js';
import { openSqliteDatabase } from '../../src/lib/server/db/sqlite.js';
import { getItemPrices } from '../../src/lib/server/services/prices';
import { itemPricesSchema } from '../../src/lib/shared/schemas';
import { GET as pricesRoute } from '../../src/routes/api/items/[catalogItemId]/prices/+server';

/**
 * Price history through the real service, route and a real database (ticket
 * 20): committed receipt lines of one item, grouped by store, with per-unit
 * aggregates inside one measurement family only. Spend keeps the lines whose
 * units cannot be compared, and receipts that are not committed contribute
 * nothing.
 */

const origin = 'http://localhost:5173';

let directory: string;
let databasePath: string;
let listId: string;
let milkId: string;
let breadId: string;
let cornerId: string;
let riversideId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'shopping-list-prices-'));
  const storageDir = join(directory, 'receipts');
  mkdirSync(storageDir, { recursive: true });
  process.env.CANONICAL_ORIGIN = origin;
  process.env.RECEIPT_STORAGE_DIR = storageDir;
  process.env.RECEIPT_CURRENCY = 'USD';
  databasePath = join(directory, 'shopping-list.sqlite');
  process.env.DATABASE_PATH = databasePath;
  closeDatabase();

  const database = openDatabase();
  migrateAndBootstrap(database, resolve(process.cwd(), 'migrations'));
  listId = (
    database.prepare('SELECT id FROM lists LIMIT 1').get() as { id: string }
  ).id;
  milkId = insertItem(database, 'Milk');
  breadId = insertItem(database, 'Bread');
  cornerId = insertStore(database, 'Corner Market');
  riversideId = insertStore(database, 'Riverside');
  database.close();
});

afterEach(() => {
  closeDatabase();
  rmSync(directory, { recursive: true, force: true });
  delete process.env.RECEIPT_CURRENCY;
});

type Database = ReturnType<typeof openSqliteDatabase>;

function openDatabase(): Database {
  return openSqliteDatabase(databasePath);
}

function useDatabase<T>(callback: (database: Database) => T): T {
  const database = openDatabase();
  try {
    return callback(database);
  } finally {
    database.close();
  }
}

function insertItem(
  database: Database,
  name: string,
  targetListId = listId,
): string {
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO catalog_items (id, list_id, display_name, normalized_name)
       VALUES (?, ?, ?, ?)`,
    )
    .run(id, targetListId, name, name.toLowerCase());
  return id;
}

function insertStore(
  database: Database,
  name: string,
  targetListId = listId,
): string {
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO groups (id, list_id, name, normalized_name, kind, position)
       VALUES (?, ?, ?, ?, 'store', 0)`,
    )
    .run(id, targetListId, name, name.toLowerCase());
  return id;
}

type ReceiptOptions = {
  status?: string;
  storeGroupId?: string | null;
  createdAt?: string;
  currency?: string | null;
};

function insertReceipt(
  options: ReceiptOptions = {},
  database = openDatabase(),
): string {
  const id = randomUUID();
  const status = options.status ?? 'committed';
  database
    .prepare(
      `INSERT INTO receipts
         (id, list_id, status, sha256, currency, store_group_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      listId,
      status,
      randomUUID().replaceAll('-', '').padEnd(64, '0'),
      options.currency === undefined ? 'USD' : options.currency,
      options.storeGroupId === undefined ? cornerId : options.storeGroupId,
      options.createdAt ?? '2026-10-01T12:00:00.000Z',
      options.createdAt ?? '2026-10-01T12:00:00.000Z',
    );
  return id;
}

type LineOptions = {
  lineIndex?: number;
  itemId?: string | null;
  printedText?: string;
  quantityReal?: number | null;
  quantityUnit?: string | null;
  unitPriceMinor?: number | null;
  totalPriceMinor?: number | null;
  reviewState?: string;
  isItemChunk?: number;
};

function insertLine(
  receiptId: string,
  options: LineOptions = {},
  database = openDatabase(),
): string {
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO receipt_lines
         (id, receipt_id, line_index, raw_text, quantity_real, quantity_unit,
          unit_price_minor, total_price_minor, is_item_chunk, catalog_item_id,
          review_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      receiptId,
      options.lineIndex ?? 0,
      options.printedText ?? 'MILK',
      options.quantityReal === undefined ? null : options.quantityReal,
      options.quantityUnit === undefined ? null : options.quantityUnit,
      options.unitPriceMinor === undefined ? null : options.unitPriceMinor,
      options.totalPriceMinor === undefined ? null : options.totalPriceMinor,
      options.isItemChunk ?? 1,
      options.itemId === undefined ? milkId : options.itemId,
      options.reviewState ?? 'bound',
    );
  return id;
}

type PricesEvent = Parameters<typeof pricesRoute>[0];

function pricesEvent(catalogItemId: string): PricesEvent {
  const url = new URL(`${origin}/api/items/${catalogItemId}/prices`);
  return {
    url,
    request: new Request(url),
    params: { catalogItemId },
  } as unknown as PricesEvent;
}

describe('price history', () => {
  it('aggregates committed lines per store and family, newest store first', () => {
    let cornerFirst = '';
    let cornerSecond = '';
    let riverside = '';
    useDatabase((database) => {
      // Corner: two mass points across two receipts, then a count line that is
      // the most recent thing bought there.
      cornerFirst = insertReceipt(
        { storeGroupId: cornerId, createdAt: '2026-10-01T12:00:00.000Z' },
        database,
      );
      insertLine(
        cornerFirst,
        {
          printedText: 'MILK 2 LB',
          quantityReal: 2,
          quantityUnit: 'lb',
          unitPriceMinor: 499,
          totalPriceMinor: 998,
        },
        database,
      );

      cornerSecond = insertReceipt(
        { storeGroupId: cornerId, createdAt: '2026-10-10T12:00:00.000Z' },
        database,
      );
      insertLine(
        cornerSecond,
        {
          lineIndex: 0,
          printedText: 'MILK 1 LB',
          quantityReal: 1,
          quantityUnit: 'lb',
          unitPriceMinor: 549,
          totalPriceMinor: 549,
        },
        database,
      );
      insertLine(
        cornerSecond,
        {
          lineIndex: 1,
          printedText: 'MILK 2 EA',
          quantityReal: 2,
          quantityUnit: 'ea',
          unitPriceMinor: null,
          totalPriceMinor: 600,
        },
        database,
      );

      // Riverside: a mass point and a package whose unit cannot be named. The
      // package is still money spent and is the most recent line there.
      riverside = insertReceipt(
        { storeGroupId: riversideId, createdAt: '2026-10-05T12:00:00.000Z' },
        database,
      );
      insertLine(
        riverside,
        {
          lineIndex: 0,
          printedText: 'MILK 1 KG',
          quantityReal: 1,
          quantityUnit: 'kg',
          unitPriceMinor: 1300,
          totalPriceMinor: 1300,
        },
        database,
      );
      insertLine(
        riverside,
        {
          lineIndex: 1,
          printedText: 'MILK PACK',
          quantityReal: null,
          quantityUnit: null,
          unitPriceMinor: null,
          totalPriceMinor: 250,
        },
        database,
      );

      // Not price history: still in review, discarded, or a different item.
      insertLine(
        insertReceipt(
          {
            status: 'review',
            storeGroupId: cornerId,
            createdAt: '2026-10-20T12:00:00.000Z',
          },
          database,
        ),
        { totalPriceMinor: 999 },
        database,
      );
      insertLine(
        insertReceipt(
          {
            status: 'discarded',
            storeGroupId: cornerId,
            createdAt: '2026-10-21T12:00:00.000Z',
          },
          database,
        ),
        { totalPriceMinor: 999 },
        database,
      );
      insertLine(
        insertReceipt(
          {
            storeGroupId: cornerId,
            createdAt: '2026-10-22T12:00:00.000Z',
          },
          database,
        ),
        { itemId: breadId, printedText: 'BREAD', totalPriceMinor: 400 },
        database,
      );
      // Committed but not price history either: the reviewer could not identify
      // this line (no binding), skipped it, or it is a parked row.
      insertLine(
        insertReceipt(
          { storeGroupId: cornerId, createdAt: '2026-10-23T12:00:00.000Z' },
          database,
        ),
        {
          itemId: null,
          reviewState: 'unknown',
          printedText: 'MYSTERY',
          totalPriceMinor: 999,
        },
        database,
      );
      insertLine(
        insertReceipt(
          { storeGroupId: cornerId, createdAt: '2026-10-24T12:00:00.000Z' },
          database,
        ),
        {
          itemId: null,
          reviewState: 'skipped',
          printedText: 'NOT MILK',
          totalPriceMinor: 999,
        },
        database,
      );
      insertLine(
        insertReceipt(
          { storeGroupId: cornerId, createdAt: '2026-10-25T12:00:00.000Z' },
          database,
        ),
        {
          itemId: milkId,
          isItemChunk: 0,
          printedText: 'SUBTOTAL',
          totalPriceMinor: 999,
        },
        database,
      );
    });

    const result = getItemPrices(milkId);
    expect(itemPricesSchema.parse(result)).toEqual(result);
    expect(result).toEqual({
      catalogItemId: milkId,
      itemName: 'Milk',
      currency: 'USD',
      receiptCount: 3,
      lineCount: 5,
      spendMinor: 3697,
      stores: [
        {
          storeGroupId: cornerId,
          storeName: 'Corner Market',
          lineCount: 3,
          spendMinor: 2147,
          lastPaidMinor: 600,
          lastPaidAt: '2026-10-10T12:00:00.000Z',
          lastReceiptId: cornerSecond,
          families: [
            {
              family: 'mass',
              unit: 'kg',
              lineCount: 2,
              lastUnitPriceMinor: 1210,
              minUnitPriceMinor: 1100,
              maxUnitPriceMinor: 1210,
              trend: 'up',
              history: [
                expect.objectContaining({
                  receiptId: cornerFirst,
                  receiptCreatedAt: '2026-10-01T12:00:00.000Z',
                  normalizedUnitPriceMinor: 1100,
                  quantityUnit: 'lb',
                  quantityReal: 2,
                  totalPriceMinor: 998,
                  printedText: 'MILK 2 LB',
                }),
                expect.objectContaining({
                  receiptId: cornerSecond,
                  normalizedUnitPriceMinor: 1210,
                }),
              ],
            },
            {
              family: 'count',
              unit: 'ea',
              lineCount: 1,
              lastUnitPriceMinor: 300,
              minUnitPriceMinor: 300,
              maxUnitPriceMinor: 300,
              trend: 'unknown',
              history: [
                expect.objectContaining({
                  receiptId: cornerSecond,
                  normalizedUnitPriceMinor: 300,
                  quantityUnit: 'ea',
                  quantityReal: 2,
                }),
              ],
            },
          ],
        },
        {
          storeGroupId: riversideId,
          storeName: 'Riverside',
          lineCount: 2,
          spendMinor: 1550,
          lastPaidMinor: 250,
          lastPaidAt: '2026-10-05T12:00:00.000Z',
          lastReceiptId: riverside,
          families: [
            {
              family: 'mass',
              unit: 'kg',
              lineCount: 1,
              lastUnitPriceMinor: 1300,
              minUnitPriceMinor: 1300,
              maxUnitPriceMinor: 1300,
              trend: 'unknown',
              history: [
                expect.objectContaining({
                  receiptId: riverside,
                  normalizedUnitPriceMinor: 1300,
                  quantityUnit: 'kg',
                }),
              ],
            },
          ],
        },
      ],
    });
  });

  it('answers an empty history for an item with no committed receipts', () => {
    expect(getItemPrices(milkId)).toEqual({
      catalogItemId: milkId,
      itemName: 'Milk',
      currency: 'USD',
      receiptCount: 0,
      lineCount: 0,
      spendMinor: 0,
      stores: [],
    });
  });

  it('refuses an item that is not on this list', () => {
    let error: { status?: number; code?: string } | undefined;
    try {
      getItemPrices(randomUUID());
    } catch (caught) {
      error = caught as { status: number; code: string };
    }
    expect(error).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('reads the history in one statement, not one per store', () => {
    useDatabase((database) => {
      const receipt = insertReceipt({ storeGroupId: cornerId }, database);
      insertLine(receipt, { totalPriceMinor: 499 }, database);
      insertLine(
        insertReceipt({ storeGroupId: riversideId }, database),
        { totalPriceMinor: 499 },
        database,
      );

      const statements: string[] = [];
      const counted = new Proxy(database, {
        get(target, property, receiver) {
          if (property === 'prepare') {
            return (sql: string) => {
              statements.push(sql);
              return target.prepare(sql);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as Database;

      getItemPrices(milkId, counted);

      const historyStatements = statements.filter((sql) =>
        /receipt_lines/i.test(sql),
      );
      expect(historyStatements).toHaveLength(1);
      expect(historyStatements[0]).toMatch(/ORDER BY r\.created_at/);
    });
  });
});

describe('GET /api/items/[catalogItemId]/prices', () => {
  it('serves the history without caching', async () => {
    let receiptId = '';
    useDatabase((database) => {
      receiptId = insertReceipt(
        { storeGroupId: cornerId, createdAt: '2026-10-01T12:00:00.000Z' },
        database,
      );
      insertLine(
        receiptId,
        {
          quantityReal: 1,
          quantityUnit: 'lb',
          unitPriceMinor: 499,
          totalPriceMinor: 499,
        },
        database,
      );
    });

    const response = await pricesRoute(pricesEvent(milkId));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = itemPricesSchema.parse(await response.json());
    expect(body.catalogItemId).toBe(milkId);
    expect(body.stores[0]).toMatchObject({
      storeGroupId: cornerId,
      storeName: 'Corner Market',
      lastReceiptId: receiptId,
      lastPaidMinor: 499,
    });
    expect(body.stores[0]?.families[0]).toMatchObject({
      family: 'mass',
      unit: 'kg',
      minUnitPriceMinor: 1100,
    });
  });

  it('answers 404 for an item that does not exist', async () => {
    const response = await pricesRoute(pricesEvent(randomUUID()));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });
});
