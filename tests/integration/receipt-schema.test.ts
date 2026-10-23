import { randomUUID } from 'node:crypto';
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateAndBootstrap } from '../../src/lib/server/db/lifecycle.js';
import { openSqliteDatabase } from '../../src/lib/server/db/sqlite.js';

type Database = ReturnType<typeof openSqliteDatabase>;
type Row = Record<string, unknown>;

let directory: string;
let database: Database;
let listId: string;

const migrationsFolder = resolve(process.cwd(), 'migrations');

function findReceiptMigration(): { tag: string; sql: string } {
  const file = readdirSync(migrationsFolder)
    .filter((name) => name.endsWith('.sql'))
    .find((name) =>
      readFileSync(join(migrationsFolder, name), 'utf8').includes(
        'CREATE TABLE `receipts`',
      ),
    );
  if (!file) throw new Error('the receipt migration does not exist yet');
  return {
    tag: file.replace(/\.sql$/u, ''),
    sql: readFileSync(join(migrationsFolder, file), 'utf8'),
  };
}

const receiptMigration = findReceiptMigration();

function existingTableSchemas(db: Database): Row[] {
  return db
    .prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'table'
         AND name NOT IN ('receipts', 'receipt_lines', 'item_aliases',
                          '__drizzle_migrations')
       ORDER BY name`,
    )
    .all() as Row[];
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'shopping-list-receipt-test-'));
  database = openSqliteDatabase(join(directory, 'shopping-list.sqlite'));
  migrateAndBootstrap(database, migrationsFolder);
  listId = (database.prepare('SELECT id FROM lists LIMIT 1').get() as Row)
    .id as string;
});

afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

function columnsOf(table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map(
    (column) => column.name as string,
  );
}

function insertReceipt(overrides: Record<string, unknown> = {}): string {
  const id = randomUUID();
  const row = {
    id,
    listId,
    status: 'pending',
    sha256: 'a'.repeat(64),
    ...overrides,
  };
  database
    .prepare(
      `INSERT INTO receipts
        (id, list_id, status, sha256, store_group_id, committed_at)
       VALUES (@id, @listId, @status, @sha256, @storeGroupId, @committedAt)`,
    )
    .run({
      storeGroupId: null,
      committedAt: null,
      ...row,
    });
  return id;
}

function insertStoreGroup(): string {
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO groups (id, list_id, name, normalized_name, kind, position)
       VALUES (?, ?, ?, ?, 'store', 0)`,
    )
    .run(id, listId, 'Corner Market', 'corner market');
  return id;
}

function insertCatalogItem(name = 'Milk'): string {
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO catalog_items (id, list_id, display_name, normalized_name)
       VALUES (?, ?, ?, ?)`,
    )
    .run(id, listId, name, name.toLowerCase());
  return id;
}

function insertLine(
  receiptId: string,
  overrides: Record<string, unknown> = {},
) {
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO receipt_lines
        (id, receipt_id, line_index, raw_text, is_item_chunk, review_state)
       VALUES (@id, @receiptId, @lineIndex, @rawText, @isItemChunk, @reviewState)`,
    )
    .run({
      id,
      receiptId,
      lineIndex: 0,
      rawText: 'DAIRYLAND 2% 1L',
      isItemChunk: 1,
      reviewState: 'unreviewed',
      ...overrides,
    });
  return id;
}

describe('receipt schema migration', () => {
  it('adds the three receipt tables on a fresh database', () => {
    const tables = (
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Row[]
    ).map((table) => table.name as string);

    expect(tables).toEqual(
      expect.arrayContaining(['receipts', 'receipt_lines', 'item_aliases']),
    );
    expect(database.pragma('foreign_key_check')).toEqual([]);
  });

  it('creates the documented columns', () => {
    expect(columnsOf('receipts')).toEqual([
      'id',
      'list_id',
      'status',
      'image_path',
      'image_bytes',
      'sha256',
      'ocr_json',
      'ocr_warnings',
      'currency',
      'subtotal_minor',
      'tax_minor',
      'total_minor',
      'captured_at',
      'store_group_id',
      'parse_version',
      'attempts',
      'last_error',
      'processed_at',
      'committed_at',
      'created_at',
      'updated_at',
    ]);
    expect(columnsOf('receipt_lines')).toEqual([
      'id',
      'receipt_id',
      'line_index',
      'raw_text',
      'parsed_name',
      'quantity_real',
      'quantity_text',
      'quantity_unit',
      'unit_price_minor',
      'total_price_minor',
      'is_item_chunk',
      'confidence',
      'catalog_item_id',
      'review_state',
      'bound_via',
      'bound_rank',
      'created_at',
      'updated_at',
    ]);
    expect(columnsOf('item_aliases')).toEqual([
      'id',
      'list_id',
      'catalog_item_id',
      'alias_text',
      'normalized_alias',
      'source',
      'created_by_receipt_line_id',
      'deleted_at',
      'created_at',
      'updated_at',
    ]);
  });

  it('adds the documented indexes, including the partial unique alias index', () => {
    const indexes = (
      database
        .prepare(
          "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index'",
        )
        .all() as Row[]
    ).filter((index) =>
      ['receipts', 'receipt_lines', 'item_aliases'].includes(
        index.tbl_name as string,
      ),
    );
    const byName = new Map(
      indexes.map((index) => [index.name as string, index]),
    );

    expect([...byName.keys()]).toEqual(
      expect.arrayContaining([
        'receipts_status_work_queue',
        'receipts_list_status',
        'receipt_lines_receipt',
        'receipt_lines_catalog',
        'item_aliases_lookup',
        'item_aliases_live_unique',
      ]),
    );
    expect(byName.get('item_aliases_live_unique')?.sql).toMatch(
      /UNIQUE.*WHERE.*deleted_at.*IS NULL/s,
    );
  });

  it('only creates new objects in the receipt migration', () => {
    expect(receiptMigration.sql).not.toMatch(
      /(ALTER TABLE|DROP TABLE|DROP INDEX|DELETE FROM|INSERT INTO)/iu,
    );
  });

  it('upgrades a database that already applied the pre-receipt migrations', () => {
    const legacyFolder = join(directory, 'legacy-migrations');
    cpSync(migrationsFolder, legacyFolder, { recursive: true });
    const journalPath = join(legacyFolder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string }[];
    };
    journal.entries = journal.entries.filter(
      (entry) => entry.tag !== receiptMigration.tag,
    );
    writeFileSync(journalPath, JSON.stringify(journal));
    rmSync(join(legacyFolder, `${receiptMigration.tag}.sql`));

    const legacyDatabase = openSqliteDatabase(join(directory, 'legacy.sqlite'));
    try {
      migrateAndBootstrap(legacyDatabase, legacyFolder);
      const schemaBefore = existingTableSchemas(legacyDatabase);

      legacyDatabase
        .prepare(
          `INSERT INTO groups (id, list_id, name, normalized_name, kind, position)
           VALUES ('legacy-store', (SELECT id FROM lists LIMIT 1),
                   'Corner Market', 'corner market', 'store', 0)`,
        )
        .run();

      migrateAndBootstrap(legacyDatabase, migrationsFolder);

      const tables = (
        legacyDatabase
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Row[]
      ).map((table) => table.name as string);
      expect(tables).toEqual(
        expect.arrayContaining(['receipts', 'receipt_lines', 'item_aliases']),
      );
      expect(existingTableSchemas(legacyDatabase)).toEqual(schemaBefore);
      expect(
        legacyDatabase
          .prepare("SELECT name FROM groups WHERE id = 'legacy-store'")
          .get(),
      ).toEqual({ name: 'Corner Market' });
      expect(legacyDatabase.pragma('foreign_key_check')).toEqual([]);
    } finally {
      legacyDatabase.close();
    }
  });

  it('defaults receipt rows to pending with no attempts', () => {
    insertReceipt();

    expect(
      database
        .prepare('SELECT status, parse_version, attempts FROM receipts')
        .get(),
    ).toEqual({ status: 'pending', parse_version: 0, attempts: 0 });
  });

  it('rejects an unknown receipt status', () => {
    expect(() => insertReceipt({ status: 'archived' })).toThrow(
      /receipts_status_check/,
    );
  });

  it('requires a store group once a receipt is committed', () => {
    expect(() =>
      insertReceipt({
        status: 'committed',
        committedAt: '2026-10-17T00:00:00.000Z',
      }),
    ).toThrow(/receipts_committed_requires_store/);

    const storeId = insertStoreGroup();
    expect(() =>
      insertReceipt({
        status: 'committed',
        storeGroupId: storeId,
        committedAt: '2026-10-17T00:00:00.000Z',
      }),
    ).not.toThrow();
  });

  it('defaults lines to unreviewed and rejects unknown enum values', () => {
    const receiptId = insertReceipt();
    insertLine(receiptId);

    expect(
      database
        .prepare('SELECT review_state, is_item_chunk FROM receipt_lines')
        .get(),
    ).toEqual({ review_state: 'unreviewed', is_item_chunk: 1 });

    expect(() => insertLine(receiptId, { reviewState: 'maybe' })).toThrow(
      /receipt_lines_review_state_check/,
    );

    expect(() =>
      database
        .prepare('UPDATE receipt_lines SET quantity_unit = ?')
        .run('dozen'),
    ).toThrow(/receipt_lines_quantity_unit_check/);
    expect(() =>
      database.prepare('UPDATE receipt_lines SET bound_via = ?').run('guessed'),
    ).toThrow(/receipt_lines_bound_via_check/);
  });

  it('accepts every documented review state and canonical unit', () => {
    const receiptId = insertReceipt();
    const lineId = insertLine(receiptId);

    for (const state of ['unreviewed', 'bound', 'new', 'unknown', 'skipped']) {
      database
        .prepare('UPDATE receipt_lines SET review_state = ? WHERE id = ?')
        .run(state, lineId);
    }
    for (const unit of ['lb', 'kg', 'oz', 'g', 'l', 'ml', 'ea']) {
      database
        .prepare('UPDATE receipt_lines SET quantity_unit = ? WHERE id = ?')
        .run(unit, lineId);
    }
    for (const via of ['auto', 'suggested', 'manual', 'created']) {
      database
        .prepare('UPDATE receipt_lines SET bound_via = ? WHERE id = ?')
        .run(via, lineId);
    }
  });

  it('cascades line deletes when a receipt is deleted', () => {
    const receiptId = insertReceipt();
    insertLine(receiptId, { lineIndex: 0 });
    insertLine(receiptId, { lineIndex: 1 });

    database.prepare('DELETE FROM receipts WHERE id = ?').run(receiptId);

    expect(
      database.prepare('SELECT COUNT(*) AS count FROM receipt_lines').get(),
    ).toEqual({ count: 0 });
  });
});

describe('item alias lifecycle', () => {
  function insertAlias(
    catalogItemId: string,
    overrides: Record<string, unknown> = {},
  ): string {
    const id = randomUUID();
    database
      .prepare(
        `INSERT INTO item_aliases
          (id, list_id, catalog_item_id, alias_text, normalized_alias, source,
           created_by_receipt_line_id)
         VALUES (@id, @listId, @catalogItemId, @aliasText, @normalizedAlias,
                 @source, @createdByReceiptLineId)`,
      )
      .run({
        id,
        listId,
        catalogItemId,
        aliasText: 'DAIRYLAND 2% 1L',
        normalizedAlias: 'dairyland 2% 1l',
        source: 'review',
        createdByReceiptLineId: null,
        ...overrides,
      });
    return id;
  }

  it('allows one live alias per item but keeps conflicting mappings', () => {
    const milk = insertCatalogItem('Milk');
    const cream = insertCatalogItem('Cream');

    expect(() => insertAlias(milk)).not.toThrow();
    expect(() => insertAlias(milk)).toThrow(/UNIQUE/);
    expect(() => insertAlias(cream)).not.toThrow();
  });

  it('relearns the same alias after a soft delete', () => {
    const milk = insertCatalogItem('Milk');
    const aliasId = insertAlias(milk);

    database
      .prepare('UPDATE item_aliases SET deleted_at = ? WHERE id = ?')
      .run('2026-10-17T00:00:00.000Z', aliasId);

    expect(() => insertAlias(milk)).not.toThrow();
  });

  it('rejects an unknown alias source', () => {
    const milk = insertCatalogItem('Milk');

    expect(() => insertAlias(milk, { source: 'guess' })).toThrow(
      /item_aliases_source_check/,
    );
  });

  it('links the alias to the reviewing receipt line', () => {
    const milk = insertCatalogItem('Milk');
    const receiptId = insertReceipt();
    const lineId = insertLine(receiptId);

    expect(() =>
      insertAlias(milk, { createdByReceiptLineId: lineId }),
    ).not.toThrow();
    expect(() =>
      insertAlias(milk, {
        aliasText: 'OTHER THING',
        normalizedAlias: 'other thing',
        createdByReceiptLineId: randomUUID(),
      }),
    ).toThrow(/FOREIGN KEY/);
  });
});
