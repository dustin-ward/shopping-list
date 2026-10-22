import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/lib/server/errors';
import { closeDatabase } from '../../src/lib/server/db/connection';
import { migrateAndBootstrap } from '../../src/lib/server/db/lifecycle.js';
import { openSqliteDatabase } from '../../src/lib/server/db/sqlite.js';
import type { HelperEngine } from '../../src/lib/server/receipts/helper-engine';
import { parseReceiptOcr } from '../../src/lib/server/receipts/parser';
import {
  reparseReceiptWithHelper,
  writeReceiptParse,
} from '../../src/lib/server/services/receipts';
import { receiptDetailSchema } from '../../src/lib/shared/schemas';
import {
  HELPER_PARSE_VERSION,
  HELPER_REPARSE_WARNING,
} from '../../src/lib/shared/receipt-helper';
import { POST as reparsePost } from '../../src/routes/api/receipts/[id]/reparse/+server';
import {
  GET as detailGet,
  PATCH as detailPatch,
} from '../../src/routes/api/receipts/[id]/+server';

/**
 * The R4 re-parse route, against the real schema. The evidence is the
 * committed washed-out fixture — the receipt the first parser cannot read — and
 * the helper reply is the committed stub fixture. What must hold: the lines are
 * replaced, and the photo and raw OCR JSON are exactly as they were.
 */

type ReparseEvent = Parameters<typeof reparsePost>[0];
type PatchEvent = Parameters<typeof detailPatch>[0];
type DetailEvent = Parameters<typeof detailGet>[0];
type Row = Record<string, unknown>;

const origin = 'http://localhost:5173';
const fixtureJson = readFileSync(
  resolve(process.cwd(), 'tests/fixtures/receipts/washed-out.json'),
  'utf8',
);
const helperFixture = JSON.parse(
  readFileSync(
    resolve(process.cwd(), 'tests/fixtures/receipts/stub-helper.json'),
    'utf8',
  ),
) as { lines: { rawText: string }[] };

let directory: string;
let storageDir: string;
let databasePath: string;
let listId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'shopping-list-helper-'));
  storageDir = join(directory, 'receipts');
  mkdirSync(storageDir, { recursive: true });
  databasePath = join(directory, 'shopping-list.sqlite');
  process.env.CANONICAL_ORIGIN = origin;
  process.env.DATABASE_PATH = databasePath;
  process.env.RECEIPT_STORAGE_DIR = storageDir;
  process.env.RECEIPT_CURRENCY = 'USD';
  process.env.RECEIPT_HELPER_URL = 'http://helper.invalid/parse';
  process.env.RECEIPT_HELPER_MODE = 'stub';
  closeDatabase();

  const database = openSqliteDatabase(databasePath);
  migrateAndBootstrap(database, resolve(process.cwd(), 'migrations'));
  listId = (database.prepare('SELECT id FROM lists LIMIT 1').get() as Row)
    .id as string;
  database.close();
});

afterEach(() => {
  closeDatabase();
  rmSync(directory, { recursive: true, force: true });
  delete process.env.RECEIPT_HELPER_URL;
  delete process.env.RECEIPT_HELPER_MODE;
  delete process.env.RECEIPT_CURRENCY;
});

/**
 * A receipt the deterministic parser read badly: the washed-out payload is
 * stored as-is, its derived lines are written the way the worker writes them,
 * and a real image is on disk so "the photo is kept" is testable.
 */
function insertWashedReceipt(
  overrides: {
    status?: string;
    updatedAt?: string;
    currency?: string;
  } = {},
): { id: string; updatedAt: string; imagePath: string } {
  const database = openSqliteDatabase(databasePath);
  try {
    const id = randomUUID();
    const updatedAt = overrides.updatedAt ?? '2026-10-17T12:00:00.000Z';
    const currency = overrides.currency ?? 'USD';
    const imagePath = `${id}.png`;
    database
      .prepare(
        `INSERT INTO receipts
           (id, list_id, status, sha256, image_path, image_bytes, currency,
            ocr_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-10-17T12:00:00.000Z', ?)`,
      )
      .run(
        id,
        listId,
        overrides.status ?? 'review',
        randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
        imagePath,
        42,
        currency,
        fixtureJson,
        updatedAt,
      );
    writeReceiptParse(database, id, parseReceiptOcr(fixtureJson), currency);
    writeFileSync(join(storageDir, imagePath), 'image-bytes');
    return { id, updatedAt, imagePath };
  } finally {
    database.close();
  }
}

function reparseEvent(id: string, body: unknown): ReparseEvent {
  const url = new URL(`${origin}/api/receipts/${id}/reparse`);
  return {
    url,
    params: { id },
    request: new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as unknown as ReparseEvent;
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

function lineRows(id: string): Row[] {
  const database = openSqliteDatabase(databasePath);
  try {
    return database
      .prepare(
        'SELECT * FROM receipt_lines WHERE receipt_id = ? ORDER BY line_index',
      )
      .all(id) as Row[];
  } finally {
    database.close();
  }
}

describe('POST /api/receipts/[id]/reparse — the fallback helper', () => {
  it('reports the washed-out parse as low-confidence before any helper is used', async () => {
    const { id } = insertWashedReceipt();

    const detail = receiptDetailSchema.parse(
      await (await detailGet(detailEvent(id))).json(),
    );

    expect(detail.parseQuality).toEqual({
      lowConfidence: true,
      helperApplied: false,
      reasons: ['no price column was found', 'no subtotal or total was found'],
    });
  });

  it('replaces the parsed lines and keeps the photo, raw payload and currency', async () => {
    const { id, updatedAt, imagePath } = insertWashedReceipt({
      currency: 'EUR',
    });
    const before = receiptRow(id);

    const response = await reparsePost(
      reparseEvent(id, { expectedUpdatedAt: updatedAt }),
    );

    expect(response.status).toBe(200);
    const detail = receiptDetailSchema.parse(await response.json());
    // The helper's reading replaced the deterministic parse, line for line.
    expect(detail.lines.map((line) => line.rawText)).toEqual(
      helperFixture.lines.map((line) => line.rawText),
    );
    expect(detail.subtotalMinor).toBe(892);
    expect(detail.totalMinor).toBe(946);
    expect(detail.parseVersion).toBe(HELPER_PARSE_VERSION);
    expect(detail.parseQuality).toMatchObject({
      lowConfidence: false,
      helperApplied: true,
    });
    expect(detail.ocrWarnings).toContain(HELPER_REPARSE_WARNING);
    // Every fresh line is unreviewed again: the old decisions described the old
    // lines, and the reviewer must see the new ones before committing.
    expect(
      detail.lines.every((line) => line.reviewState === 'unreviewed'),
    ).toBe(true);

    // The raw artifacts are untouched: same OCR payload, same photo bytes.
    const after = receiptRow(id);
    expect(after.ocr_json).toBe(before.ocr_json);
    expect(after.image_path).toBe(imagePath);
    expect(after.currency).toBe('EUR');
    expect(detail.imageAvailable).toBe(true);
    expect(detail.ocrText).toContain('NANAS');
    expect(existsSync(join(storageDir, imagePath))).toBe(true);
    expect(after.updated_at).not.toBe(updatedAt);
  });

  it('refuses to replace lines over a decision made since the view loaded', async () => {
    const { id, updatedAt } = insertWashedReceipt();
    const beforeReparse = receiptDetailSchema.parse(
      await (await detailGet(detailEvent(id))).json(),
    );
    const itemLine = beforeReparse.lines.find((line) => line.isItemChunk);
    expect(itemLine).toBeDefined();
    const marked = await detailPatch(
      patchEvent(id, {
        expectedUpdatedAt: updatedAt,
        lines: [{ id: itemLine!.id, reviewState: 'unknown' }],
      }),
    );
    expect(marked.status).toBe(200);

    const response = await reparsePost(
      reparseEvent(id, { expectedUpdatedAt: beforeReparse.updatedAt }),
    );

    // The reviewer's decision moved the receipt on; the replacement would
    // silently discard it, so the stale guard refuses instead.
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'RECEIPT_CHANGED' },
    });
    expect(lineRows(id)).toHaveLength(beforeReparse.lines.length);
  });

  it('refuses a stale view after the receipt changed', async () => {
    const { id } = insertWashedReceipt();
    const before = lineRows(id);

    const response = await reparsePost(
      reparseEvent(id, { expectedUpdatedAt: '2026-10-17T11:00:00.000Z' }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'RECEIPT_CHANGED' },
    });
    expect(lineRows(id)).toEqual(before);
  });

  it('refuses a receipt that is not in review', async () => {
    const { id, updatedAt } = insertWashedReceipt({ status: 'discarded' });

    const response = await reparsePost(
      reparseEvent(id, { expectedUpdatedAt: updatedAt }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'RECEIPT_NOT_REPARSEABLE' },
    });
  });

  it('is unavailable when no helper is configured', async () => {
    delete process.env.RECEIPT_HELPER_URL;
    const { id, updatedAt } = insertWashedReceipt();
    const before = lineRows(id);

    const response = await reparsePost(
      reparseEvent(id, { expectedUpdatedAt: updatedAt }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'HELPER_DISABLED' },
    });
    expect(lineRows(id)).toEqual(before);
  });

  it('leaves the receipt untouched when the helper fails', async () => {
    const { id, updatedAt } = insertWashedReceipt();
    const before = lineRows(id);
    const beforeRow = receiptRow(id);
    const failing: HelperEngine = {
      async reParse() {
        throw new AppError(502, 'HELPER_FAILED', 'The helper is down.');
      },
    };

    await expect(
      reparseReceiptWithHelper(
        id,
        { expectedUpdatedAt: updatedAt },
        {
          engine: failing,
        },
      ),
    ).rejects.toMatchObject({ code: 'HELPER_FAILED' });

    expect(lineRows(id)).toEqual(before);
    expect(receiptRow(id)).toMatchObject({
      ocr_json: beforeRow.ocr_json,
      updated_at: beforeRow.updated_at,
      parse_version: beforeRow.parse_version,
    });
  });
});
