import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handle } from '../../src/hooks.server';
import { closeDatabase } from '../../src/lib/server/db/connection';
import { migrateAndBootstrap } from '../../src/lib/server/db/lifecycle.js';
import { openSqliteDatabase } from '../../src/lib/server/db/sqlite.js';
import { getServerInstanceId } from '../../src/lib/server/instance';
import {
  getReceiptDetail,
  writeReceiptParse,
} from '../../src/lib/server/services/receipts';
import type { ParsedReceipt } from '../../src/lib/server/receipts/parser';
import { normalizeName } from '../../src/lib/shared/normalize';
import {
  itemOverviewSchema,
  mergeItemsResultSchema,
  renameItemResultSchema,
  snapshotSchema,
} from '../../src/lib/shared/schemas';
import { GET as itemsRoute } from '../../src/routes/api/items/+server';
import { PATCH as renameItemRoute } from '../../src/routes/api/items/[id]/+server';
import { POST as mergeItemsRoute } from '../../src/routes/api/items/[id]/merge/+server';
import { GET as snapshotRoute } from '../../src/routes/api/snapshot/+server';

/**
 * Canonical-item administration through the real routes and a real database:
 * a rename that moves the household term without touching printed evidence, and
 * a merge that moves every reference, retires duplicate aliases, refuses an
 * active-entry conflict, and proves with before/after counts that nothing was
 * left behind.
 */

const origin = 'http://localhost:5173';
const host = new URL(origin).host;

let directory: string;
let databasePath: string;
let listId: string;
let milkId: string;
let wholeMilkId: string;
let storeGroupId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'shopping-list-items-'));
  process.env.CANONICAL_ORIGIN = origin;
  process.env.RECEIPT_STORAGE_DIR = join(directory, 'receipts');
  mkdirSync(process.env.RECEIPT_STORAGE_DIR, { recursive: true });
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
  wholeMilkId = insertItem(database, 'Whole milk');
  storeGroupId = randomUUID();
  database
    .prepare(
      `INSERT INTO groups (id, list_id, name, normalized_name, kind, position)
       VALUES (?, ?, 'Corner Market', 'corner market', 'store', 0)`,
    )
    .run(storeGroupId, listId);
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
    .run(id, targetListId, name, normalizeName(name));
  return id;
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

function all<T extends Row>(sql: string, ...parameters: unknown[]): T[] {
  const database = openDatabase();
  try {
    return database.prepare(sql).all(...parameters) as T[];
  } finally {
    database.close();
  }
}

function run(sql: string, ...parameters: unknown[]): void {
  const database = openDatabase();
  try {
    database.prepare(sql).run(...parameters);
  } finally {
    database.close();
  }
}

function revision(): number {
  return one<{ revision: number }>(
    'SELECT revision FROM app_state WHERE id = 1',
  ).revision;
}

function insertAlias(
  catalogItemId: string,
  aliasText: string,
  options: {
    deletedAt?: string | null;
    source?: 'manual' | 'review' | 'auto';
  } = {},
): string {
  const id = randomUUID();
  run(
    `INSERT INTO item_aliases
       (id, list_id, catalog_item_id, alias_text, normalized_alias, source, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    listId,
    catalogItemId,
    aliasText,
    normalizeName(aliasText),
    options.source ?? 'review',
    options.deletedAt ?? null,
  );
  return id;
}

function insertReceipt(status: 'review' | 'committed' = 'committed'): string {
  const id = randomUUID();
  run(
    `INSERT INTO receipts
       (id, list_id, status, sha256, currency, store_group_id, ocr_json,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, 'USD', ?, ?, '2026-10-17T12:00:00.000Z',
             '2026-10-17T12:00:00.000Z')`,
    id,
    listId,
    status,
    randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
    storeGroupId,
    JSON.stringify({ pages: [{ lines: [{ text: 'x' }] }] }),
  );
  return id;
}

function insertLine(
  receiptId: string,
  catalogItemId: string | null,
  rawText: string,
  lineIndex = 0,
): string {
  const id = randomUUID();
  run(
    `INSERT INTO receipt_lines
       (id, receipt_id, line_index, raw_text, parsed_name, is_item_chunk,
        review_state, catalog_item_id, bound_via, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'manual', '2026-10-17T12:00:00.000Z',
             '2026-10-17T12:00:00.000Z')`,
    id,
    receiptId,
    lineIndex,
    rawText,
    rawText,
    catalogItemId ? 'bound' : 'unknown',
    catalogItemId,
  );
  return id;
}

function insertEntry(
  catalogItemId: string,
  name: string,
  status: 'active' | 'purchased' | 'cancelled' = 'active',
): string {
  const id = randomUUID();
  const completed = status === 'purchased' ? '2026-10-17T12:00:00.000Z' : null;
  const archived = status === 'cancelled' ? '2026-10-17T12:00:00.000Z' : null;
  run(
    `INSERT INTO list_entries
       (id, list_id, catalog_item_id, name, status, revision, completed_at,
        archived_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, '2026-10-17T12:00:00.000Z',
             '2026-10-17T12:00:00.000Z')`,
    id,
    listId,
    catalogItemId,
    name,
    status,
    completed,
    archived,
  );
  return id;
}

function insertPurchase(
  entryId: string,
  catalogItemId: string,
  nameSnapshot: string,
): string {
  const id = randomUUID();
  run(
    `INSERT INTO purchases
       (id, entry_id, catalog_item_id, name_snapshot, purchased_at)
     VALUES (?, ?, ?, ?, '2026-10-17T12:00:00.000Z')`,
    id,
    entryId,
    catalogItemId,
    nameSnapshot,
  );
  return id;
}

function category(name: string): string {
  const id = randomUUID();
  run(
    `INSERT INTO groups (id, list_id, name, normalized_name, kind, position)
     VALUES (?, ?, ?, ?, 'category', 1)`,
    id,
    listId,
    name,
    normalizeName(name),
  );
  return id;
}

function addMembership(catalogItemId: string, groupId: string): void {
  run(
    'INSERT INTO catalog_item_groups (catalog_item_id, group_id) VALUES (?, ?)',
    catalogItemId,
    groupId,
  );
}

async function submit(
  route: (event: never) => Response | Promise<Response>,
  request: Request,
  params: Record<string, string> = {},
): Promise<Response> {
  const event = { request, url: new URL(request.url), params };
  return handle({
    event,
    resolve: async () => route(event as never),
  } as never);
}

function mutationRequest(
  path: string,
  method: 'PATCH' | 'POST',
  body: unknown,
): Request {
  return new Request(`${origin}${path}`, {
    method,
    headers: { host, origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function rename(
  itemId: string,
  body: { expectedName: string; name: string },
): Promise<Response> {
  return submit(
    renameItemRoute,
    mutationRequest(`/api/items/${itemId}`, 'PATCH', {
      serverInstanceId: getServerInstanceId(),
      ...body,
    }),
    { id: itemId },
  );
}

function merge(
  absorbedId: string,
  body: {
    survivorId: string;
    expectedName: string;
    expectedSurvivorName: string;
  },
): Promise<Response> {
  return submit(
    mergeItemsRoute,
    mutationRequest(`/api/items/${absorbedId}/merge`, 'POST', {
      serverInstanceId: getServerInstanceId(),
      ...body,
    }),
    { id: absorbedId },
  );
}

async function overview() {
  const response = await submit(
    itemsRoute,
    new Request(`${origin}/api/items`, { headers: { host, origin } }),
  );
  expect(response.status).toBe(200);
  return itemOverviewSchema.parse(await response.json());
}

async function snapshot() {
  const response = await submit(
    snapshotRoute,
    new Request(`${origin}/api/snapshot`, { headers: { host, origin } }),
  );
  expect(response.status).toBe(200);
  return snapshotSchema.parse(await response.json());
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

/** Parse one line onto a fresh review, i.e. what the worker's tick writes. */
function parseLine(rawText: string) {
  const receiptId = insertReceipt('review');
  const database = openDatabase();
  try {
    writeReceiptParse(database, receiptId, parsedReceipt(rawText), 'USD');
  } finally {
    database.close();
  }
  return getReceiptDetail(receiptId).lines[0]!;
}

describe('GET /api/items', () => {
  it('lists every item with the counts a merge has to move', async () => {
    const receiptId = insertReceipt('committed');
    insertLine(receiptId, milkId, 'MILK 1GAL');
    insertLine(insertReceipt('review'), milkId, 'MILK 2% 1L', 0);
    const entryId = insertEntry(milkId, 'Milk', 'active');
    insertPurchase(entryId, milkId, 'Milk');
    insertAlias(milkId, 'DAIRYLAND 2% 1L');
    insertAlias(milkId, 'MILK 1GAL', { deletedAt: '2026-10-01T00:00:00.000Z' });
    const groupId = category('Dairy');
    addMembership(milkId, groupId);

    const body = await overview();

    expect(body.items.map((item) => item.name)).toEqual(['Milk', 'Whole milk']);
    expect(body.items[0]!.counts).toEqual({
      receiptLines: 2,
      committedReceiptLines: 1,
      purchases: 1,
      liveAliases: 1,
      deletedAliases: 1,
      listEntries: 1,
      activeListEntries: 1,
      categoryMemberships: 1,
    });
    expect(body.items[1]!.counts.receiptLines).toBe(0);
  });
});

describe('PATCH /api/items/[id] — rename', () => {
  it('renames the household term and the visible list entries, touching no printed evidence', async () => {
    const committed = insertReceipt('committed');
    const lineId = insertLine(committed, milkId, 'DAIRYLAND 2% 1L');
    const aliasId = insertAlias(milkId, 'DAIRYLAND 2% 1L');
    const activeEntry = insertEntry(milkId, 'Milk', 'active');
    const purchasedEntry = insertEntry(milkId, 'Milk', 'purchased');
    const cancelledEntry = insertEntry(milkId, 'Milk', 'cancelled');
    const purchaseId = insertPurchase(purchasedEntry, milkId, 'Milk');
    const before = revision();

    const response = await rename(milkId, {
      expectedName: 'Milk',
      name: 'Organic milk',
    });

    expect(response.status).toBe(200);
    const result = renameItemResultSchema.parse(await response.json());
    expect(result).toMatchObject({
      item: { id: milkId, name: 'Organic milk' },
      renamedEntryCount: 2,
    });
    expect(result.revision).toBeGreaterThan(before);
    expect(revision()).toBe(result.revision);

    expect(
      one<{ display_name: string; normalized_name: string }>(
        'SELECT display_name, normalized_name FROM catalog_items WHERE id = ?',
        milkId,
      ),
    ).toEqual({
      display_name: 'Organic milk',
      normalized_name: 'organic milk',
    });
    // Visible entries render the term; the cancelled one is history.
    expect(
      one<{ name: string; revision: number }>(
        'SELECT name, revision FROM list_entries WHERE id = ?',
        activeEntry,
      ),
    ).toMatchObject({ name: 'Organic milk', revision: 2 });
    expect(
      one<{ name: string; revision: number }>(
        'SELECT name, revision FROM list_entries WHERE id = ?',
        purchasedEntry,
      ),
    ).toMatchObject({ name: 'Organic milk', revision: 2 });
    expect(
      one<{ name: string; revision: number }>(
        'SELECT name, revision FROM list_entries WHERE id = ?',
        cancelledEntry,
      ),
    ).toMatchObject({ name: 'Milk', revision: 1 });

    // Printed evidence and its snapshots never move with the household term.
    expect(
      one<{ raw_text: string; parsed_name: string }>(
        'SELECT raw_text, parsed_name FROM receipt_lines WHERE id = ?',
        lineId,
      ),
    ).toEqual({ raw_text: 'DAIRYLAND 2% 1L', parsed_name: 'DAIRYLAND 2% 1L' });
    expect(
      one<{ alias_text: string }>(
        'SELECT alias_text FROM item_aliases WHERE id = ?',
        aliasId,
      ).alias_text,
    ).toBe('DAIRYLAND 2% 1L');
    expect(
      one<{ name_snapshot: string }>(
        'SELECT name_snapshot FROM purchases WHERE id = ?',
        purchaseId,
      ).name_snapshot,
    ).toBe('Milk');

    const parsed = await snapshot();
    expect(parsed.catalogItems.find((item) => item.id === milkId)?.name).toBe(
      'Organic milk',
    );
    expect(parsed.entries.find((entry) => entry.id === activeEntry)?.name).toBe(
      'Organic milk',
    );
  });

  it('refuses a name another item already uses, without writing', async () => {
    const entryId = insertEntry(milkId, 'Milk', 'active');
    const before = revision();

    const response = await rename(milkId, {
      expectedName: 'Milk',
      name: 'Whole milk',
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: { code: string; details?: { itemId?: string } };
    };
    expect(body.error.code).toBe('ITEM_NAME_EXISTS');
    expect(body.error.details?.itemId).toBe(wholeMilkId);
    expect(revision()).toBe(before);
    expect(
      one<{ display_name: string }>(
        'SELECT display_name FROM catalog_items WHERE id = ?',
        milkId,
      ).display_name,
    ).toBe('Milk');
    expect(
      one<{ name: string; revision: number }>(
        'SELECT name, revision FROM list_entries WHERE id = ?',
        entryId,
      ),
    ).toMatchObject({ name: 'Milk', revision: 1 });
  });

  it('refuses a rename from a stale view', async () => {
    const response = await rename(milkId, {
      expectedName: 'MILK',
      name: 'Organic milk',
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: { code: string; details?: { currentName?: string } };
    };
    expect(body.error.code).toBe('ITEM_CHANGED');
    expect(body.error.details?.currentName).toBe('Milk');
  });

  it('refuses a rename sent to a restarted server', async () => {
    const before = revision();
    const response = await submit(
      renameItemRoute,
      mutationRequest(`/api/items/${milkId}`, 'PATCH', {
        serverInstanceId: randomUUID(),
        expectedName: 'Milk',
        name: 'Organic milk',
      }),
      { id: milkId },
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SERVER_CHANGED');
    expect(revision()).toBe(before);
    expect(
      one<{ display_name: string }>(
        'SELECT display_name FROM catalog_items WHERE id = ?',
        milkId,
      ).display_name,
    ).toBe('Milk');
  });

  it('is a no-op when the term is unchanged, and moves no revision', async () => {
    const before = revision();

    const response = await rename(milkId, {
      expectedName: 'Milk',
      name: 'Milk',
    });

    expect(response.status).toBe(200);
    const result = renameItemResultSchema.parse(await response.json());
    expect(result).toMatchObject({
      revision: before,
      renamedEntryCount: 0,
      item: { id: milkId, name: 'Milk' },
    });
    expect(revision()).toBe(before);
  });

  it('refuses an item from another list', async () => {
    const database = openDatabase();
    let foreignId: string;
    try {
      const otherListId = randomUUID();
      database
        .prepare('INSERT INTO lists (id, name) VALUES (?, ?)')
        .run(otherListId, 'Someone else');
      foreignId = insertItem(database, 'Eggs', otherListId);
    } finally {
      database.close();
    }

    const response = await rename(foreignId, {
      expectedName: 'Eggs',
      name: 'Free-range eggs',
    });

    expect(response.status).toBe(404);
  });
});

describe('POST /api/items/[id]/merge', () => {
  /** The absorbed item with one row of every reference kind. */
  function seedAbsorbed() {
    const committedLine = insertLine(
      insertReceipt('committed'),
      milkId,
      'DAIRYLAND 2% 1L',
    );
    const reviewLine = insertLine(insertReceipt('review'), milkId, 'MILK 1GAL');
    const activeEntry = insertEntry(milkId, 'Milk', 'active');
    const cancelledEntry = insertEntry(milkId, 'Milk', 'cancelled');
    const purchaseId = insertPurchase(activeEntry, milkId, 'Milk');
    const liveAliasId = insertAlias(milkId, 'DAIRYLAND 2% 1L');
    const deletedAliasId = insertAlias(milkId, 'MILK 1GAL', {
      deletedAt: '2026-10-01T00:00:00.000Z',
    });
    const dairy = category('Dairy');
    const chilled = category('Chilled');
    addMembership(milkId, dairy);
    addMembership(milkId, chilled);
    addMembership(wholeMilkId, chilled);

    return {
      committedLine,
      reviewLine,
      activeEntry,
      cancelledEntry,
      purchaseId,
      liveAliasId,
      deletedAliasId,
      dairy,
      chilled,
    };
  }

  it('moves every reference, unions memberships, and proves it with counts', async () => {
    const seeded = seedAbsorbed();
    const before = revision();

    const response = await merge(milkId, {
      survivorId: wholeMilkId,
      expectedName: 'Milk',
      expectedSurvivorName: 'Whole milk',
    });

    expect(response.status).toBe(200);
    const result = mergeItemsResultSchema.parse(await response.json());
    expect(result).toMatchObject({
      survivor: { id: wholeMilkId, name: 'Whole milk' },
      absorbed: { id: milkId, name: 'Milk' },
      aliasesMoved: 2,
      aliasesRetired: 0,
      aliasesLearned: 1,
      aliasesRevived: 0,
      membershipsDropped: 1,
    });
    expect(result.revision).toBeGreaterThan(before);
    expect(revision()).toBe(result.revision);

    expect(result.before.absorbed).toEqual({
      receiptLines: 2,
      committedReceiptLines: 1,
      purchases: 1,
      liveAliases: 1,
      deletedAliases: 1,
      listEntries: 2,
      activeListEntries: 1,
      categoryMemberships: 2,
    });
    expect(result.after.absorbed).toEqual({
      receiptLines: 0,
      committedReceiptLines: 0,
      purchases: 0,
      liveAliases: 0,
      deletedAliases: 0,
      listEntries: 0,
      activeListEntries: 0,
      categoryMemberships: 0,
    });
    expect(result.after.survivor).toMatchObject({
      receiptLines: 2,
      committedReceiptLines: 1,
      purchases: 1,
      liveAliases: 2,
      deletedAliases: 1,
      listEntries: 2,
      activeListEntries: 1,
      categoryMemberships: 2,
    });

    // Every reference now points at the survivor; snapshots and printed text
    // keep exactly what was recorded.
    expect(all('SELECT id FROM catalog_items WHERE id = ?', milkId)).toEqual(
      [],
    );
    expect(
      all<{ id: string }>(
        'SELECT id FROM receipt_lines WHERE catalog_item_id = ?',
        milkId,
      ),
    ).toEqual([]);
    expect(
      one<{ catalog_item_id: string; raw_text: string }>(
        'SELECT catalog_item_id, raw_text FROM receipt_lines WHERE id = ?',
        seeded.committedLine,
      ),
    ).toEqual({ catalog_item_id: wholeMilkId, raw_text: 'DAIRYLAND 2% 1L' });
    expect(
      one<{ catalog_item_id: string }>(
        'SELECT catalog_item_id FROM receipt_lines WHERE id = ?',
        seeded.reviewLine,
      ).catalog_item_id,
    ).toBe(wholeMilkId);
    expect(
      one<{ catalog_item_id: string; name_snapshot: string }>(
        'SELECT catalog_item_id, name_snapshot FROM purchases WHERE id = ?',
        seeded.purchaseId,
      ),
    ).toEqual({ catalog_item_id: wholeMilkId, name_snapshot: 'Milk' });

    // The live entry adopts the surviving term; the cancelled one is history.
    expect(
      one<{ catalog_item_id: string; name: string; revision: number }>(
        'SELECT catalog_item_id, name, revision FROM list_entries WHERE id = ?',
        seeded.activeEntry,
      ),
    ).toEqual({
      catalog_item_id: wholeMilkId,
      name: 'Whole milk',
      revision: 2,
    });
    expect(
      one<{ catalog_item_id: string; name: string; revision: number }>(
        'SELECT catalog_item_id, name, revision FROM list_entries WHERE id = ?',
        seeded.cancelledEntry,
      ),
    ).toEqual({ catalog_item_id: wholeMilkId, name: 'Milk', revision: 1 });

    // Aliases moved, the absorbed term was learned, and the duplicate category
    // membership was dropped (the survivor already had it).
    expect(
      one<{ catalog_item_id: string }>(
        'SELECT catalog_item_id FROM item_aliases WHERE id = ?',
        seeded.liveAliasId,
      ).catalog_item_id,
    ).toBe(wholeMilkId);
    expect(
      one<{ catalog_item_id: string; deleted_at: string | null }>(
        'SELECT catalog_item_id, deleted_at FROM item_aliases WHERE id = ?',
        seeded.deletedAliasId,
      ),
    ).toEqual({
      catalog_item_id: wholeMilkId,
      deleted_at: '2026-10-01T00:00:00.000Z',
    });
    expect(
      one<{
        catalog_item_id: string;
        source: string;
        deleted_at: string | null;
      }>(
        'SELECT catalog_item_id, source, deleted_at FROM item_aliases WHERE normalized_alias = ?',
        'milk',
      ),
    ).toEqual({
      catalog_item_id: wholeMilkId,
      source: 'manual',
      deleted_at: null,
    });
    expect(
      all<{ group_id: string }>(
        'SELECT group_id FROM catalog_item_groups WHERE catalog_item_id = ? ORDER BY group_id',
        wholeMilkId,
      ).map((row) => row.group_id),
    ).toEqual([seeded.dairy, seeded.chilled].sort());

    // The app's own reads agree: the survivor is the only item, and the list
    // entry renders the surviving term.
    const household = await snapshot();
    expect(household.catalogItems.map((item) => item.name)).toEqual([
      'Whole milk',
    ]);
    expect(
      household.entries.find((entry) => entry.id === seeded.activeEntry)?.name,
    ).toBe('Whole milk');
    expect((await overview()).items.map((item) => item.name)).toEqual([
      'Whole milk',
    ]);
  });

  it('learns the absorbed term so it still resolves to the survivor', async () => {
    seedAbsorbed();

    expect(
      (
        await merge(milkId, {
          survivorId: wholeMilkId,
          expectedName: 'Milk',
          expectedSurvivorName: 'Whole milk',
        })
      ).status,
    ).toBe(200);

    // Both the moved printed variant and the absorbed household term now bind
    // the survivor on the next receipt.
    expect(parseLine('DAIRYLAND 2% 1L')).toMatchObject({
      catalogItemId: wholeMilkId,
      reviewState: 'bound',
      boundVia: 'auto',
    });
    expect(parseLine('Milk')).toMatchObject({
      catalogItemId: wholeMilkId,
      reviewState: 'bound',
      boundVia: 'auto',
    });
  });

  it('retires a live duplicate alias instead of claiming the phrase twice', async () => {
    const survivorAlias = insertAlias(wholeMilkId, 'DAIRYLAND 2% 1L');
    const absorbedAlias = insertAlias(milkId, 'DAIRYLAND 2% 1L');

    const response = await merge(milkId, {
      survivorId: wholeMilkId,
      expectedName: 'Milk',
      expectedSurvivorName: 'Whole milk',
    });

    expect(response.status).toBe(200);
    const result = mergeItemsResultSchema.parse(await response.json());
    expect(result).toMatchObject({
      aliasesMoved: 1,
      aliasesRetired: 1,
      aliasesLearned: 1,
      aliasesRevived: 0,
    });
    expect(
      one<{ deleted_at: string | null }>(
        'SELECT deleted_at FROM item_aliases WHERE id = ?',
        survivorAlias,
      ).deleted_at,
    ).toBeNull();
    expect(
      one<{ catalog_item_id: string; deleted_at: string | null }>(
        'SELECT catalog_item_id, deleted_at FROM item_aliases WHERE id = ?',
        absorbedAlias,
      ),
    ).toMatchObject({ catalog_item_id: wholeMilkId });
    expect(
      one<{ deleted_at: string | null }>(
        'SELECT deleted_at FROM item_aliases WHERE id = ?',
        absorbedAlias,
      ).deleted_at,
    ).not.toBeNull();

    // One live claim remains, so matching still binds the phrase.
    expect(parseLine('DAIRYLAND 2% 1L')).toMatchObject({
      catalogItemId: wholeMilkId,
      reviewState: 'bound',
    });
  });

  it('revives a soft-deleted survivor alias for the absorbed term', async () => {
    const retired = insertAlias(wholeMilkId, 'Milk', {
      deletedAt: '2026-10-01T00:00:00.000Z',
    });

    const response = await merge(milkId, {
      survivorId: wholeMilkId,
      expectedName: 'Milk',
      expectedSurvivorName: 'Whole milk',
    });

    expect(response.status).toBe(200);
    const result = mergeItemsResultSchema.parse(await response.json());
    expect(result).toMatchObject({
      aliasesLearned: 0,
      aliasesRevived: 1,
    });
    const revived = one<{ deleted_at: string | null; source: string }>(
      'SELECT deleted_at, source FROM item_aliases WHERE id = ?',
      retired,
    );
    expect(revived).toEqual({ deleted_at: null, source: 'manual' });
    expect(parseLine('Milk')).toMatchObject({ catalogItemId: wholeMilkId });
  });

  it('refuses while both items have an active list entry, writing nothing', async () => {
    const absorbedEntry = insertEntry(milkId, 'Milk', 'active');
    const survivorEntry = insertEntry(wholeMilkId, 'Whole milk', 'active');
    const aliasId = insertAlias(milkId, 'DAIRYLAND 2% 1L');
    const before = revision();

    const response = await merge(milkId, {
      survivorId: wholeMilkId,
      expectedName: 'Milk',
      expectedSurvivorName: 'Whole milk',
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: {
        code: string;
        details?: {
          absorbedEntryId?: string;
          survivorEntryId?: string;
        };
      };
    };
    expect(body.error.code).toBe('MERGE_ACTIVE_ENTRY_CONFLICT');
    expect(body.error.details).toEqual({
      absorbedEntryId: absorbedEntry,
      survivorEntryId: survivorEntry,
    });
    expect(revision()).toBe(before);
    expect(
      all(
        'SELECT id FROM catalog_items WHERE id IN (?, ?) ORDER BY id',
        milkId,
        wholeMilkId,
      ),
    ).toHaveLength(2);
    expect(
      one<{ catalog_item_id: string }>(
        'SELECT catalog_item_id FROM item_aliases WHERE id = ?',
        aliasId,
      ).catalog_item_id,
    ).toBe(milkId);
  });

  it('refuses merging an item into itself', async () => {
    const response = await merge(milkId, {
      survivorId: milkId,
      expectedName: 'Milk',
      expectedSurvivorName: 'Milk',
    });

    expect(response.status).toBe(400);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe('INVALID_MERGE');
  });

  it('refuses an item that no longer exists', async () => {
    const response = await merge(randomUUID(), {
      survivorId: wholeMilkId,
      expectedName: 'Milk',
      expectedSurvivorName: 'Whole milk',
    });

    expect(response.status).toBe(404);
  });

  it('refuses a stale view of either item', async () => {
    const staleName = await merge(milkId, {
      survivorId: wholeMilkId,
      expectedName: 'MILK',
      expectedSurvivorName: 'Whole milk',
    });
    expect(staleName.status).toBe(409);
    expect(
      ((await staleName.json()) as { error: { code: string } }).error.code,
    ).toBe('ITEM_CHANGED');

    const staleSurvivor = await merge(milkId, {
      survivorId: wholeMilkId,
      expectedName: 'Milk',
      expectedSurvivorName: 'WHOLE MILK',
    });
    expect(staleSurvivor.status).toBe(409);
    expect(
      ((await staleSurvivor.json()) as { error: { code: string } }).error.code,
    ).toBe('ITEM_CHANGED');
  });

  it('refuses a merge sent to a restarted server', async () => {
    const before = revision();
    const response = await submit(
      mergeItemsRoute,
      mutationRequest(`/api/items/${milkId}/merge`, 'POST', {
        serverInstanceId: randomUUID(),
        survivorId: wholeMilkId,
        expectedName: 'Milk',
        expectedSurvivorName: 'Whole milk',
      }),
      { id: milkId },
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SERVER_CHANGED');
    expect(revision()).toBe(before);
    expect(
      all(
        'SELECT id FROM catalog_items WHERE id IN (?, ?)',
        milkId,
        wholeMilkId,
      ),
    ).toHaveLength(2);
  });

  it('refuses a survivor from another list, leaving both items alone', async () => {
    const database = openDatabase();
    let foreignId: string;
    try {
      const otherListId = randomUUID();
      database
        .prepare('INSERT INTO lists (id, name) VALUES (?, ?)')
        .run(otherListId, 'Someone else');
      foreignId = insertItem(database, 'Eggs', otherListId);
    } finally {
      database.close();
    }
    const before = revision();

    const response = await merge(milkId, {
      survivorId: foreignId,
      expectedName: 'Milk',
      expectedSurvivorName: 'Eggs',
    });

    expect(response.status).toBe(404);
    expect(revision()).toBe(before);
    expect(
      one<{ id: string }>('SELECT id FROM catalog_items WHERE id = ?', milkId)
        .id,
    ).toBe(milkId);
  });
});
