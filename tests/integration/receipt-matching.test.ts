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
import type { OcrEngine } from '../../src/lib/server/receipts/ocr-engine';
import { normalizeName } from '../../src/lib/shared/normalize';
import {
  receiptDetailSchema,
  type ReceiptDetailLine,
} from '../../src/lib/shared/schemas';
import { runReceiptWorkerTick } from '../../src/lib/server/services/receipt-worker';
import {
  getReceiptDetail,
  writeReceiptParse,
} from '../../src/lib/server/services/receipts';
import { parseReceiptOcr } from '../../src/lib/server/receipts/parser';

/**
 * The matcher through the real database: the clean-grocery fixture is parsed by
 * the worker, tier-1 lines land bound with `auto` provenance inside the parse
 * transaction, and the receipt detail serves the chips the review editor draws.
 */

type Database = ReturnType<typeof openSqliteDatabase>;
type Row = Record<string, unknown>;

const cleanGroceryJson = readFileSync(
  resolve(process.cwd(), 'tests/fixtures/receipts/clean-grocery.json'),
  'utf8',
);

let directory: string;
let storageDir: string;
let database: Database;
let listId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'shopping-list-matching-'));
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
});

function fixtureEngine(raw: string): OcrEngine {
  return { extract: async () => ({ raw }) };
}

function insertCatalogItem(name: string): string {
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO catalog_items (id, list_id, display_name, normalized_name)
       VALUES (?, ?, ?, ?)`,
    )
    .run(id, listId, name, normalizeName(name));
  return id;
}

function insertStoreGroup(name = 'Corner Market'): string {
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO groups (id, list_id, name, normalized_name, kind, position)
       VALUES (?, ?, ?, ?, 'store', 0)`,
    )
    .run(id, listId, name, name.toLowerCase());
  return id;
}

function insertReceipt(overrides: Record<string, unknown> = {}): string {
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO receipts
         (id, list_id, status, sha256, image_path, image_bytes, store_group_id,
          committed_at, created_at, updated_at)
       VALUES (@id, @listId, @status, @sha256, @imagePath, 16, @storeGroupId,
               @committedAt, '2026-10-17T12:00:00.000Z', '2026-10-17T12:00:00.000Z')`,
    )
    .run({
      id,
      listId,
      status: 'pending',
      sha256: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
      imagePath: `${id}.jpg`,
      storeGroupId: null,
      committedAt: null,
      ...overrides,
    });
  writeFileSync(join(storageDir, `${id}.jpg`), 'fake-image-bytes');
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
         (id, receipt_id, line_index, raw_text, parsed_name, is_item_chunk,
          review_state, catalog_item_id, bound_via)
       VALUES (@id, @receiptId, @lineIndex, @rawText, @parsedName, 1,
               'bound', @catalogItemId, 'manual')`,
    )
    .run({
      id,
      receiptId,
      lineIndex,
      rawText: `LINE ${lineIndex}`,
      parsedName: null,
      catalogItemId: null,
      ...overrides,
    });
  return id;
}

/** An alias a human confirmed on the given line (source `review` unless stated). */
function insertAlias(
  catalogItemId: string,
  aliasText: string,
  options: {
    source?: 'manual' | 'review' | 'auto';
    createdByReceiptLineId?: string | null;
  } = {},
): string {
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO item_aliases
         (id, list_id, catalog_item_id, alias_text, normalized_alias, source,
          created_by_receipt_line_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      listId,
      catalogItemId,
      aliasText,
      normalizeName(aliasText),
      options.source ?? 'review',
      options.createdByReceiptLineId ?? null,
    );
  return id;
}

/** An alias learned at this store: a committed receipt's bound line learned it. */
function learnedAtStore(
  catalogItemId: string,
  aliasText: string,
  storeGroupId: string,
): void {
  const committed = insertReceipt({
    status: 'committed',
    storeGroupId,
    committedAt: '2026-10-10T12:00:00.000Z',
  });
  const line = insertLine(committed, 0, {
    rawText: aliasText,
    parsedName: aliasText,
    catalogItemId,
  });
  insertAlias(catalogItemId, aliasText, { createdByReceiptLineId: line });
}

function lineView(
  detail: { lines: ReceiptDetailLine[] },
  rawText: string,
): ReceiptDetailLine {
  const line = detail.lines.find((candidate) => candidate.rawText === rawText);
  expect(line, `no line rendered for ${rawText}`).toBeDefined();
  return line!;
}

/** The chips' names in rank order. */
function chips(line: ReceiptDetailLine): string[] {
  return line.suggestions.map((suggestion) => suggestion.name);
}

describe('matching through the worker', () => {
  it('binds the tier-1 lines and serves the tier-2 chips', async () => {
    const store = insertStoreGroup();
    const milk = insertCatalogItem('Milk');
    const milkSize = insertCatalogItem('Milk 2%');
    const bread = insertCatalogItem('Bread');
    const galaApples = insertCatalogItem('Gala Apples');
    const fruit = insertCatalogItem('Fruit');

    // Confirmed phrasings: a printed variant for Bread (tier 1 via alias), the
    // same-store evidence for Milk, and a phrase two items both claim.
    learnedAtStore(bread, 'SOURDOUGH BREAD', store);
    learnedAtStore(milk, 'DAIRYLAND 2% 1L', store);
    const ambiguousReceipt = insertReceipt({
      status: 'committed',
      storeGroupId: store,
      committedAt: '2026-10-11T12:00:00.000Z',
    });
    const ambiguousLine = insertLine(ambiguousReceipt, 0, {
      rawText: 'GALA APPLES 3LB',
    });
    insertAlias(galaApples, 'GALA APPLES 3LB', {
      createdByReceiptLineId: ambiguousLine,
    });
    insertAlias(fruit, 'GALA APPLES 3LB', {
      createdByReceiptLineId: ambiguousLine,
    });
    insertAlias(fruit, 'MILK 2% 1L', { source: 'auto' });

    const id = insertReceipt({ storeGroupId: store });
    const outcome = await runReceiptWorkerTick({
      database,
      storageDir,
      engine: fixtureEngine(cleanGroceryJson),
    });
    expect(outcome).toEqual({ outcome: 'processed', receiptId: id });

    const detail = getReceiptDetail(id, database);
    expect(receiptDetailSchema.parse(detail)).toEqual(detail);

    // Tier 1: an exact name and a human-confirmed alias arrive bound as `auto`.
    const sourdough = lineView(detail, 'SOURDOUGH BREAD');
    expect(sourdough).toMatchObject({
      reviewState: 'bound',
      catalogItemId: bread,
      boundVia: 'auto',
      boundRank: null,
    });
    expect(sourdough.suggestions).toEqual([
      {
        catalogItemId: bread,
        name: 'Bread',
        tier: 1,
        score: 1,
        sameStore: true,
      },
    ]);

    // Tier 2: never auto-bound, ranked with the same-store boost first.
    const milkLine = lineView(detail, 'MILK 2% 1L');
    expect(milkLine).toMatchObject({
      reviewState: 'unreviewed',
      catalogItemId: null,
      boundVia: null,
    });
    expect(chips(milkLine)).toEqual(['Milk', 'Milk 2%']);
    expect(milkLine.suggestions[0]).toMatchObject({
      catalogItemId: milk,
      tier: 2,
      sameStore: true,
    });
    expect(milkLine.suggestions[1]).toMatchObject({
      catalogItemId: milkSize,
      tier: 2,
      sameStore: false,
    });

    // The ambiguity guard: two items claim the phrase, so nothing binds and both
    // are offered.
    const apples = lineView(detail, 'GALA APPLES 3LB');
    expect(apples).toMatchObject({
      reviewState: 'unreviewed',
      catalogItemId: null,
    });
    expect(apples.suggestions).toEqual([
      expect.objectContaining({ catalogItemId: fruit, tier: 1 }),
      expect.objectContaining({ catalogItemId: galaApples, tier: 1 }),
    ]);

    // A phrase with an extra significant word clears neither gate, and parked
    // rows are never candidates for anything.
    expect(chips(lineView(detail, 'CHEDDAR CHEESE 80Z'))).toEqual([]);
    expect(chips(lineView(detail, 'SUBTOTAL'))).toEqual([]);
  });

  it('does not honour an alias no human confirmed', async () => {
    const fruit = insertCatalogItem('Fruit');
    insertAlias(fruit, 'MILK 2% 1L', { source: 'auto' });
    const id = insertReceipt();

    await runReceiptWorkerTick({
      database,
      storageDir,
      engine: fixtureEngine(cleanGroceryJson),
    });

    const milkLine = lineView(getReceiptDetail(id, database), 'MILK 2% 1L');
    expect(milkLine).toMatchObject({
      reviewState: 'unreviewed',
      catalogItemId: null,
    });
    expect(chips(milkLine)).toEqual([]);
  });

  it('re-binds the same lines when the same parse is written again', async () => {
    const bread = insertCatalogItem('Bread');
    learnedAtStore(bread, 'SOURDOUGH BREAD', insertStoreGroup());
    const id = insertReceipt();

    writeReceiptParse(database, id, parseReceiptOcr(cleanGroceryJson), 'USD');
    writeReceiptParse(database, id, parseReceiptOcr(cleanGroceryJson), 'USD');

    const bound = database
      .prepare(
        `SELECT catalog_item_id AS catalogItemId, bound_via AS boundVia
           FROM receipt_lines
          WHERE receipt_id = ? AND review_state = 'bound'`,
      )
      .all(id);
    expect(bound).toEqual([{ catalogItemId: bread, boundVia: 'auto' }]);
  });
});
