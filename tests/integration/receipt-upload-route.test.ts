import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/lib/server/db/connection';
import { migrateAndBootstrap } from '../../src/lib/server/db/lifecycle.js';
import { openSqliteDatabase } from '../../src/lib/server/db/sqlite.js';
import { getServerInstanceId } from '../../src/lib/server/instance';
import { handle } from '../../src/hooks.server';
import { POST } from '../../src/routes/api/receipts/+server';

type ReceiptsEvent = Parameters<typeof POST>[0];

const origin = 'http://localhost:5173';
const host = new URL(origin).host;

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'shopping-list-upload-route-'));
  process.env.CANONICAL_ORIGIN = origin;
  const databasePath = join(directory, 'shopping-list.sqlite');
  process.env.DATABASE_PATH = databasePath;
  process.env.RECEIPT_STORAGE_DIR = join(directory, 'receipts');
  closeDatabase();

  const database = openSqliteDatabase(databasePath);
  migrateAndBootstrap(database, resolve(process.cwd(), 'migrations'));
  database.close();
});

afterEach(() => {
  closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

function jpeg(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(256);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
}

function uploadRequest(
  options: { origin?: string | null; serverInstanceId?: string } = {},
): Request {
  const body = new FormData();
  body.set('image', new Blob([jpeg()], { type: 'image/jpeg' }), 'receipt.jpg');
  const headers = new Headers({
    host,
    'x-server-instance-id': options.serverInstanceId ?? getServerInstanceId(),
  });
  const requestOrigin = options.origin === undefined ? origin : options.origin;
  if (requestOrigin !== null) headers.set('origin', requestOrigin);
  return new Request(`${origin}/api/receipts`, {
    method: 'POST',
    body,
    headers,
  });
}

/** Run a request through the server hook and then the receipt route. */
async function submit(request: Request): Promise<Response> {
  const event = {
    request,
    url: new URL(request.url),
  } as unknown as ReceiptsEvent;
  return handle({ event, resolve: async () => POST(event) });
}

describe('POST /api/receipts', () => {
  it('returns 201 with the new pending receipt for a valid image', async () => {
    const response = await submit(uploadRequest());

    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      id: expect.any(String),
      status: 'pending',
    });
  });

  it('returns the existing receipt for a duplicate without creating another', async () => {
    const first = await (await submit(uploadRequest())).json();

    const response = await submit(uploadRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: first.id,
      status: 'pending',
      alreadyCaptured: true,
    });
  });

  it('refuses an upload from a different server instance', async () => {
    const response = await submit(
      uploadRequest({ serverInstanceId: randomUUID() }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'SERVER_CHANGED' },
    });
  });

  it('rejects a cross-origin upload through the hook', async () => {
    const response = await submit(
      uploadRequest({ origin: 'https://evil.example' }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: 'ORIGIN_REJECTED' },
    });
  });

  it('rejects an upload with no origin header', async () => {
    const response = await submit(uploadRequest({ origin: null }));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: 'ORIGIN_REJECTED' },
    });
  });
});
