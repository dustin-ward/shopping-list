import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/lib/server/db/connection';
import { migrateAndBootstrap } from '../../src/lib/server/db/lifecycle.js';
import { openSqliteDatabase } from '../../src/lib/server/db/sqlite.js';
import { GET as capabilitiesRoute } from '../../src/routes/api/receipts/capabilities/+server';
import { GET as detailRoute } from '../../src/routes/api/receipts/[id]/+server';
import { GET as imageRoute } from '../../src/routes/api/receipts/[id]/image/+server';
import { GET as listRoute } from '../../src/routes/api/receipts/+server';

type ListEvent = Parameters<typeof listRoute>[0];
type DetailEvent = Parameters<typeof detailRoute>[0];
type ImageEvent = Parameters<typeof imageRoute>[0];
type CapabilitiesEvent = Parameters<typeof capabilitiesRoute>[0];

const origin = 'http://localhost:5173';

let directory: string;
let storageDir: string;
let databasePath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'shopping-list-read-routes-'));
  storageDir = join(directory, 'receipts');
  mkdirSync(storageDir, { recursive: true });
  process.env.CANONICAL_ORIGIN = origin;
  process.env.RECEIPT_STORAGE_DIR = storageDir;
  databasePath = join(directory, 'shopping-list.sqlite');
  process.env.DATABASE_PATH = databasePath;
  closeDatabase();

  const database = openSqliteDatabase(databasePath);
  migrateAndBootstrap(database, resolve(process.cwd(), 'migrations'));
  database.close();
});

afterEach(() => {
  closeDatabase();
  rmSync(directory, { recursive: true, force: true });
  delete process.env.RECEIPT_OCR_URL;
  delete process.env.RECEIPT_CURRENCY;
});

function insertReceipt(overrides: Record<string, unknown> = {}): string {
  const database = openSqliteDatabase(databasePath);
  try {
    const id = randomUUID();
    database
      .prepare(
        `INSERT INTO receipts
           (id, list_id, status, sha256, image_path, image_bytes, total_minor,
            created_at, updated_at)
         VALUES (@id, (SELECT id FROM lists LIMIT 1), @status, @sha256,
                 @imagePath, 16, @totalMinor, @createdAt, @updatedAt)`,
      )
      .run({
        id,
        status: 'pending',
        sha256: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
        imagePath: `${id}.jpg`,
        totalMinor: null,
        createdAt: '2026-10-17T12:00:00.000Z',
        updatedAt: '2026-10-17T12:00:00.000Z',
        ...overrides,
      });
    return id;
  } finally {
    database.close();
  }
}

function insertLine(receiptId: string, lineIndex: number): void {
  const database = openSqliteDatabase(databasePath);
  try {
    database
      .prepare(
        `INSERT INTO receipt_lines
           (id, receipt_id, line_index, raw_text, is_item_chunk, review_state)
         VALUES (?, ?, ?, ?, 1, 'unknown')`,
      )
      .run(randomUUID(), receiptId, lineIndex, `LINE ${lineIndex}`);
  } finally {
    database.close();
  }
}

function listEvent(query = ''): ListEvent {
  const url = new URL(`${origin}/api/receipts${query}`);
  return { url, request: new Request(url) } as unknown as ListEvent;
}

function detailEvent(id: string): DetailEvent {
  const url = new URL(`${origin}/api/receipts/${id}`);
  return {
    url,
    request: new Request(url),
    params: { id },
  } as unknown as DetailEvent;
}

function imageEvent(id: string): ImageEvent {
  const url = new URL(`${origin}/api/receipts/${id}/image`);
  return {
    url,
    request: new Request(url),
    params: { id },
  } as unknown as ImageEvent;
}

function capabilitiesEvent(): CapabilitiesEvent {
  const url = new URL(`${origin}/api/receipts/capabilities`);
  return { url, request: new Request(url) } as unknown as CapabilitiesEvent;
}

describe('GET /api/receipts', () => {
  it('lists receipts without caching', async () => {
    const id = insertReceipt({ totalMinor: 1860 });

    const response = await listRoute(listEvent());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      items: [
        expect.objectContaining({
          id,
          status: 'pending',
          totalMinor: 1860,
          imageAvailable: true,
        }),
      ],
      nextCursor: null,
    });
  });

  it('applies the status and hasUnknowns query filters', async () => {
    const clean = insertReceipt({ status: 'review' });
    const unknown = insertReceipt({ status: 'review' });
    insertLine(unknown, 0);
    insertReceipt({ status: 'failed' });

    const response = await listRoute(
      listEvent('?status=review&hasUnknowns=false'),
    );

    expect(response.status).toBe(200);
    expect(
      (await response.json()).items.map((item: { id: string }) => item.id),
    ).toEqual([clean]);
  });

  it('rejects an invalid status filter', async () => {
    const response = await listRoute(listEvent('?status=nonsense'));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'INVALID_STATUS' },
    });
  });
});

describe('GET /api/receipts/[id]', () => {
  it('returns the detail payload', async () => {
    const id = insertReceipt({ status: 'review' });

    const response = await detailRoute(detailEvent(id));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      id,
      status: 'review',
      imageAvailable: true,
      lines: [],
    });
  });

  it('reports an unknown receipt', async () => {
    const response = await detailRoute(detailEvent(randomUUID()));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });
});

describe('GET /api/receipts/[id]/image', () => {
  it('streams the stored image without caching', async () => {
    const id = insertReceipt();
    writeFileSync(join(storageDir, `${id}.jpg`), 'fake-image-bytes');

    const response = await imageRoute(imageEvent(id));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('fake-image-bytes');
  });

  it('reports a purged image as missing', async () => {
    const id = insertReceipt({ imagePath: null });

    const response = await imageRoute(imageEvent(id));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });
});

describe('GET /api/receipts/capabilities', () => {
  it('reports the feature off by default', async () => {
    delete process.env.RECEIPT_OCR_URL;

    const response = await capabilitiesRoute(capabilitiesEvent());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ enabled: false, currency: 'USD' });
  });

  it('reports the feature on when the OCR URL is configured', async () => {
    process.env.RECEIPT_OCR_URL = 'http://receipt-ocr:8060/ocr';
    process.env.RECEIPT_CURRENCY = 'GBP';

    const response = await capabilitiesRoute(capabilitiesEvent());

    expect(await response.json()).toEqual({ enabled: true, currency: 'GBP' });
  });
});
