import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handle } from '../../src/hooks.server';
import { closeDatabase } from '../../src/lib/server/db/connection';
import { migrateAndBootstrap } from '../../src/lib/server/db/lifecycle.js';
import { openSqliteDatabase } from '../../src/lib/server/db/sqlite.js';
import { matchingStatsSchema } from '../../src/lib/shared/schemas';
import { GET as matchingStatsRoute } from '../../src/routes/api/matching-stats/+server';

/**
 * Suggestion telemetry through the real route and a real database (ticket 18):
 * the shares read committed `bound_via` values and the rank distribution reads
 * committed `bound_rank` values. Committed item lines are the denominator, so
 * every bucket plus the no-binding residual reconciles with the lines it claims.
 */

const origin = 'http://localhost:5173';
const host = new URL(origin).host;

let directory: string;
let databasePath: string;
let listId: string;
let storeGroupId: string;
let milkId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'shopping-list-matching-stats-'));
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
  database
    .prepare(
      `INSERT INTO catalog_items (id, list_id, display_name, normalized_name)
       VALUES (?, ?, 'Milk', 'milk')`,
    )
    .run(milkId, listId);
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

/** A receipt row; a committed receipt always carries the store the schema requires. */
function insertReceipt(
  options: {
    status?: 'review' | 'committed' | 'discarded';
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
        status === 'committed' ? '2026-10-17T12:00:00.000Z' : null,
      ),
  );
  return id;
}

/** One line, with the provenance telemetry reads. */
function insertLine(
  receiptId: string,
  options: {
    lineIndex?: number;
    isItemChunk?: boolean;
    reviewState?: 'bound' | 'new' | 'unknown' | 'skipped';
    boundVia?: 'auto' | 'suggested' | 'manual' | 'created' | null;
    boundRank?: number | null;
  } = {},
): string {
  const id = randomUUID();
  useDatabase((database) =>
    database
      .prepare(
        `INSERT INTO receipt_lines
           (id, receipt_id, line_index, raw_text, is_item_chunk, review_state,
            catalog_item_id, bound_via, bound_rank)
         VALUES (?, ?, ?, 'SOMETHING', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        receiptId,
        options.lineIndex ?? 0,
        (options.isItemChunk ?? true) ? 1 : 0,
        options.reviewState ?? 'bound',
        options.boundVia ? milkId : null,
        options.boundVia ?? null,
        options.boundRank ?? null,
      ),
  );
  return id;
}

async function submit(request: Request): Promise<Response> {
  const event = { request, url: new URL(request.url), params: {} };
  return handle({
    event,
    resolve: async () => matchingStatsRoute(event as never),
  } as never);
}

async function stats(): Promise<ReturnType<typeof matchingStatsSchema.parse>> {
  const response = await submit(
    new Request(`${origin}/api/matching-stats`, {
      headers: { host, origin },
    }),
  );
  expect(response.status).toBe(200);
  return matchingStatsSchema.parse(await response.json());
}

describe('GET /api/matching-stats', () => {
  it('is all zeros before any receipt is committed', async () => {
    expect(await stats()).toEqual({
      committedReceiptCount: 0,
      lineCount: 0,
      noBindingLineCount: 0,
      sources: [
        { source: 'auto', lineCount: 0 },
        { source: 'suggested', lineCount: 0 },
        { source: 'manual', lineCount: 0 },
        { source: 'created', lineCount: 0 },
      ],
      suggested: { lineCount: 0, ranks: [], unrankedLineCount: 0 },
    });
  });

  it('counts only committed item lines of this list, and reconciles', async () => {
    const first = insertReceipt();
    insertLine(first, { lineIndex: 0, boundVia: 'auto' });
    insertLine(first, {
      lineIndex: 1,
      boundVia: 'suggested',
      boundRank: 1,
    });
    insertLine(first, {
      lineIndex: 2,
      boundVia: 'suggested',
      boundRank: 3,
    });
    insertLine(first, { lineIndex: 3, boundVia: 'manual' });
    insertLine(first, {
      lineIndex: 4,
      reviewState: 'new',
      boundVia: 'created',
    });
    insertLine(first, {
      lineIndex: 5,
      reviewState: 'unknown',
      boundVia: null,
    });
    insertLine(first, {
      lineIndex: 6,
      reviewState: 'skipped',
      boundVia: null,
    });
    // A parked row is not a purchased thing and has no binding to count.
    insertLine(first, {
      lineIndex: 7,
      isItemChunk: false,
      reviewState: 'bound',
      boundVia: 'auto',
    });

    const second = insertReceipt();
    insertLine(second, { lineIndex: 0, boundVia: 'auto' });
    insertLine(second, {
      lineIndex: 1,
      boundVia: 'suggested',
      boundRank: 1,
    });
    insertLine(second, {
      lineIndex: 2,
      boundVia: 'suggested',
      boundRank: 7,
    });
    insertLine(second, {
      lineIndex: 3,
      boundVia: 'suggested',
      boundRank: null,
    });

    // Not telemetry: review, discarded, and another list's committed receipt.
    const review = insertReceipt({ status: 'review' });
    insertLine(review, { boundVia: 'auto' });
    const discarded = insertReceipt({ status: 'discarded' });
    insertLine(discarded, { boundVia: 'auto' });
    const otherList = randomUUID();
    useDatabase((database) =>
      database
        .prepare('INSERT INTO lists (id, name) VALUES (?, ?)')
        .run(otherList, 'Someone else'),
    );
    const foreign = insertReceipt({ listId: otherList });
    insertLine(foreign, { boundVia: 'auto' });

    const body = await stats();

    expect(body.committedReceiptCount).toBe(2);
    expect(body.lineCount).toBe(11);
    expect(body.sources).toEqual([
      { source: 'auto', lineCount: 2 },
      { source: 'suggested', lineCount: 5 },
      { source: 'manual', lineCount: 1 },
      { source: 'created', lineCount: 1 },
    ]);
    expect(body.noBindingLineCount).toBe(2);
    expect(body.suggested).toEqual({
      lineCount: 5,
      ranks: [
        { rank: 1, lineCount: 2 },
        { rank: 3, lineCount: 1 },
        { rank: 7, lineCount: 1 },
      ],
      unrankedLineCount: 1,
    });

    const bucketed = body.sources.reduce(
      (total, source) => total + source.lineCount,
      body.noBindingLineCount,
    );
    expect(bucketed).toBe(body.lineCount);
    const ranked = body.suggested.ranks.reduce(
      (total, rank) => total + rank.lineCount,
      body.suggested.unrankedLineCount,
    );
    expect(ranked).toBe(body.suggested.lineCount);
  });

  it('counts a committed receipt that has no item lines', async () => {
    insertReceipt();
    expect(await stats()).toMatchObject({
      committedReceiptCount: 1,
      lineCount: 0,
      noBindingLineCount: 0,
    });
  });
});
