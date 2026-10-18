import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handle } from '../../src/hooks.server';
import { closeDatabase } from '../../src/lib/server/db/connection';
import { migrateAndBootstrap } from '../../src/lib/server/db/lifecycle.js';
import { openSqliteDatabase } from '../../src/lib/server/db/sqlite.js';
import {
  getReceiptDetail,
  writeReceiptParse,
} from '../../src/lib/server/services/receipts';
import type { ParsedReceipt } from '../../src/lib/server/receipts/parser';
import { aliasOverviewSchema } from '../../src/lib/shared/schemas';
import { GET as aliasesRoute } from '../../src/routes/api/aliases/+server';
import { POST as deleteAliasRoute } from '../../src/routes/api/aliases/[id]/delete/+server';
import { POST as commitRoute } from '../../src/routes/api/receipts/[id]/commit/+server';

/**
 * The alias lifecycle through the real routes and a real database: what the
 * overview shows per item (deleted rows included), what deleting stops, what
 * the next review's commit relearns, and what a phrase two items claim does
 * instead of binding.
 */

const origin = 'http://localhost:5173';
const host = new URL(origin).host;

let directory: string;
let storageDir: string;
let databasePath: string;
let listId: string;
let milkId: string;
let storeGroupId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'shopping-list-aliases-'));
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
  milkId = insertCatalogItem(database, listId, 'Milk');
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

function insertCatalogItem(
  database: Database,
  targetListId: string,
  name: string,
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

function openDatabase(): Database {
  return openSqliteDatabase(databasePath);
}

/** Add one catalog item to this list, the way a commit materializing a draft would. */
function addCatalogItem(name: string): string {
  const database = openDatabase();
  try {
    return insertCatalogItem(database, listId, name);
  } finally {
    database.close();
  }
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

function revision(): number {
  return one<{ revision: number }>(
    'SELECT revision FROM app_state WHERE id = 1',
  ).revision;
}

/** Insert an alias row directly: the learning path is exercised separately. */
function insertAlias(options: {
  catalogItemId?: string;
  aliasText: string;
  source?: 'manual' | 'review' | 'auto';
  deletedAt?: string | null;
}): string {
  const id = randomUUID();
  const database = openDatabase();
  try {
    database
      .prepare(
        `INSERT INTO item_aliases
           (id, list_id, catalog_item_id, alias_text, normalized_alias, source,
            deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        listId,
        options.catalogItemId ?? milkId,
        options.aliasText,
        options.aliasText.toLowerCase(),
        options.source ?? 'review',
        options.deletedAt ?? null,
      );
  } finally {
    database.close();
  }
  return id;
}

/** A receipt row the review path can work with; no image or OCR on disk needed. */
function insertReceipt(overrides: Record<string, unknown> = {}): string {
  const id = randomUUID();
  const database = openDatabase();
  try {
    database
      .prepare(
        `INSERT INTO receipts
           (id, list_id, status, sha256, currency, store_group_id, ocr_json,
            created_at, updated_at)
         VALUES (@id, @listId, @status, @sha256, 'USD', @storeGroupId, @ocrJson,
                 '2026-10-17T12:00:00.000Z', '2026-10-17T12:00:00.000Z')`,
      )
      .run({
        id,
        listId,
        status: 'review',
        sha256: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
        storeGroupId,
        ocrJson: JSON.stringify({ pages: [{ lines: [{ text: 'x' }] }] }),
        ...overrides,
      });
  } finally {
    database.close();
  }
  return id;
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

/** Parse one line onto a fresh receipt, i.e. what the worker's tick writes. */
function parseLine(rawText: string): string {
  const receiptId = insertReceipt();
  const database = openDatabase();
  try {
    writeReceiptParse(database, receiptId, parsedReceipt(rawText), 'USD');
  } finally {
    database.close();
  }
  return receiptId;
}

/** Run one request through the server hook and then the route under test. */
async function submit(
  route: (event: never) => Response | Promise<Response>,
  request: Request,
  params: Record<string, string> = {},
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

async function overview(): Promise<
  ReturnType<typeof aliasOverviewSchema.parse>
> {
  const response = await submit(
    aliasesRoute,
    new Request(`${origin}/api/aliases`, { headers: { host, origin } }),
  );
  expect(response.status).toBe(200);
  return aliasOverviewSchema.parse(await response.json());
}

function softDelete(aliasId: string): Promise<Response> {
  return submit(
    deleteAliasRoute,
    new Request(`${origin}/api/aliases/${aliasId}/delete`, {
      method: 'POST',
      headers: { host, origin, 'content-type': 'application/json' },
      body: '{}',
    }),
    { id: aliasId },
  );
}

function commitReceipt(receiptId: string): Promise<Response> {
  return submit(
    commitRoute,
    new Request(`${origin}/api/receipts/${receiptId}/commit`, {
      method: 'POST',
      headers: { host, origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedUpdatedAt: '2026-10-17T12:00:00.000Z',
      }),
    }),
    { id: receiptId },
  );
}

function lineOf(receiptId: string) {
  return getReceiptDetail(receiptId).lines[0]!;
}

describe('GET /api/aliases', () => {
  it('groups the list\u2019s aliases per item, live ones before deleted ones', async () => {
    const breadId = addCatalogItem('Bread');
    const deletedId = insertAlias({
      aliasText: 'DAIRYLAND 2% 1L',
      deletedAt: '2026-10-16T09:00:00.000Z',
    });
    const liveId = insertAlias({ aliasText: 'MILK 1GAL' });
    const breadAliasId = insertAlias({
      catalogItemId: breadId,
      aliasText: 'SOURDOUGH BREAD',
      source: 'manual',
    });

    const body = await overview();

    // Items are alphabetical, and a deleted row is still part of the answer:
    // that is the audit trail the surface can reveal.
    expect(body.items.map((item) => item.name)).toEqual(['Bread', 'Milk']);
    expect(body.items[1]!.aliases.map((alias) => alias.id)).toEqual([
      liveId,
      deletedId,
    ]);
    expect(body.items[0]!.aliases).toEqual([
      expect.objectContaining({
        id: breadAliasId,
        aliasText: 'SOURDOUGH BREAD',
        normalizedAlias: 'sourdough bread',
        source: 'manual',
        deletedAt: null,
      }),
    ]);
    expect(body.ambiguous).toEqual([]);
  });

  it('reports nothing ambiguous while one item claims a phrase', async () => {
    insertAlias({ aliasText: 'DAIRYLAND 2% 1L' });

    expect((await overview()).ambiguous).toEqual([]);
  });
});

describe('deleting and relearning an alias', () => {
  it('auto-binds a confirmed phrase until the alias is deleted', async () => {
    const aliasId = insertAlias({ aliasText: 'DAIRYLAND 2% 1L' });

    const bound = parseLine('DAIRYLAND 2% 1L');
    expect(lineOf(bound)).toMatchObject({
      catalogItemId: milkId,
      reviewState: 'bound',
      boundVia: 'auto',
    });

    const response = await softDelete(aliasId);
    expect(response.status).toBe(200);

    // The very next receipt falls back to asking: a deleted alias is skipped by
    // every lookup, so nothing auto-binds.
    const unbound = parseLine('DAIRYLAND 2% 1L');
    expect(lineOf(unbound)).toMatchObject({
      catalogItemId: null,
      reviewState: 'unreviewed',
      boundVia: null,
    });
  });

  it('relearns on the next commit: the same reviewed text revives the row', async () => {
    const aliasId = insertAlias({ aliasText: 'DAIRYLAND 2% 1L' });
    await softDelete(aliasId);
    const deleted = (await overview()).items[0]!.aliases[0]!;
    expect(deleted).toMatchObject({ id: aliasId, source: 'review' });
    expect(deleted.deletedAt).not.toBeNull();

    // The reviewer binds the printed text again on a later receipt…
    const receiptId = insertReceipt();
    const database = openDatabase();
    const lineId = randomUUID();
    try {
      database
        .prepare(
          `INSERT INTO receipt_lines
             (id, receipt_id, line_index, raw_text, parsed_name, is_item_chunk,
              review_state, catalog_item_id, bound_via, created_at, updated_at)
           VALUES (?, ?, 0, 'DAIRYLAND 2% 1L', 'DAIRYLAND 2% 1L', 1, 'bound',
                   ?, 'manual', '2026-10-17T12:00:00.000Z',
                   '2026-10-17T12:00:00.000Z')`,
        )
        .run(lineId, receiptId, milkId);
    } finally {
      database.close();
    }

    expect((await commitReceipt(receiptId)).status).toBe(200);

    // …and the commit revives the same row rather than inserting a second one,
    // because the review is what confirms the phrase again.
    const revived = one<Row>(
      'SELECT id, deleted_at, source, created_by_receipt_line_id FROM item_aliases WHERE normalized_alias = ?',
      'dairyland 2% 1l',
    );
    expect(revived).toMatchObject({
      id: aliasId,
      deleted_at: null,
      source: 'review',
      created_by_receipt_line_id: lineId,
    });

    // The relearned alias binds the next receipt again.
    expect(lineOf(parseLine('DAIRYLAND 2% 1L'))).toMatchObject({
      catalogItemId: milkId,
      reviewState: 'bound',
      boundVia: 'auto',
    });
  });
});

describe('a phrase two items claim', () => {
  /** "MILK" is claimed by the item named Milk and by Buttermilk's alias. */
  async function makeAmbiguous(): Promise<string> {
    const buttermilkId = addCatalogItem('Buttermilk');
    const aliasId = insertAlias({
      catalogItemId: buttermilkId,
      aliasText: 'MILK',
    });
    return aliasId;
  }

  it('is reported with both claims, and never binds a line', async () => {
    await makeAmbiguous();

    const body = await overview();
    expect(body.ambiguous).toEqual([
      {
        phrase: 'Milk',
        normalizedPhrase: 'milk',
        items: [
          { catalogItemId: body.items[0]!.catalogItemId, name: 'Buttermilk' },
          { catalogItemId: milkId, name: 'Milk' },
        ],
      },
    ]);

    // Matching asks instead: the line keeps both candidates and no binding.
    const detail = getReceiptDetail(parseLine('MILK'));
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

  it('resolves when the conflicting alias is deleted, and says so', async () => {
    const aliasId = await makeAmbiguous();

    await softDelete(aliasId);

    // The conflict is gone from the report and from matching: deleting the
    // wrong claim is a deliberate act, never a silent retarget.
    expect((await overview()).ambiguous).toEqual([]);
    expect(lineOf(parseLine('MILK'))).toMatchObject({
      catalogItemId: milkId,
      reviewState: 'bound',
      boundVia: 'auto',
    });
  });
});

describe('POST /api/aliases/[id]/delete', () => {
  it('soft-deletes the row, answers with the fresh overview, and moves no revision', async () => {
    const aliasId = insertAlias({ aliasText: 'DAIRYLAND 2% 1L' });
    const before = revision();

    const response = await softDelete(aliasId);

    expect(response.status).toBe(200);
    const body = aliasOverviewSchema.parse(await response.json());
    expect(body.items[0]!.aliases[0]).toMatchObject({
      id: aliasId,
      aliasText: 'DAIRYLAND 2% 1L',
    });
    expect(body.items[0]!.aliases[0]!.deletedAt).not.toBeNull();
    // Aliases never enter the snapshot, so nothing the rest of the app polls
    // has changed.
    expect(revision()).toBe(before);
  });

  it('is idempotent and never moves the recorded deletion time', async () => {
    const aliasId = insertAlias({ aliasText: 'MILK 1GAL' });

    await softDelete(aliasId);
    const first = one<{ deleted_at: string }>(
      'SELECT deleted_at FROM item_aliases WHERE id = ?',
      aliasId,
    ).deleted_at;

    const again = await softDelete(aliasId);

    expect(again.status).toBe(200);
    expect(
      one<{ deleted_at: string }>(
        'SELECT deleted_at FROM item_aliases WHERE id = ?',
        aliasId,
      ).deleted_at,
    ).toBe(first);
  });

  it('refuses an unknown alias without writing anything', async () => {
    const before = revision();

    const response = await softDelete(randomUUID());

    expect(response.status).toBe(404);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe('NOT_FOUND');
    expect(revision()).toBe(before);
  });

  it('refuses an alias that belongs to another list', async () => {
    const database = openDatabase();
    const otherListId = randomUUID();
    let foreignAliasId: string;
    try {
      database
        .prepare('INSERT INTO lists (id, name) VALUES (?, ?)')
        .run(otherListId, 'Someone else');
      const itemId = insertCatalogItem(database, otherListId, 'Eggs');
      foreignAliasId = randomUUID();
      database
        .prepare(
          `INSERT INTO item_aliases
             (id, list_id, catalog_item_id, alias_text, normalized_alias, source)
           VALUES (?, ?, ?, 'EGGS 12CT', 'eggs 12ct', 'review')`,
        )
        .run(foreignAliasId, otherListId, itemId);
    } finally {
      database.close();
    }

    const response = await softDelete(foreignAliasId);

    expect(response.status).toBe(404);
    expect(
      one<{ deleted_at: string | null }>(
        'SELECT deleted_at FROM item_aliases WHERE id = ?',
        foreignAliasId,
      ).deleted_at,
    ).toBeNull();
  });
});
