import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/lib/server/db/connection';
import { migrateAndBootstrap } from '../../src/lib/server/db/lifecycle.js';
import { openSqliteDatabase } from '../../src/lib/server/db/sqlite.js';
import { handle } from '../../src/hooks.server';
import { POST } from '../../src/routes/api/receipts/[id]/retry/+server';

type RetryEvent = Parameters<typeof POST>[0];

const origin = 'http://localhost:5173';
const host = new URL(origin).host;

let directory: string;
let databasePath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'shopping-list-retry-route-'));
  process.env.CANONICAL_ORIGIN = origin;
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
});

function insertReceipt(
  status: string,
  attempts: number,
  lastError: string | null,
): string {
  const database = openSqliteDatabase(databasePath);
  try {
    const id = randomUUID();
    database
      .prepare(
        `INSERT INTO receipts (id, list_id, status, sha256, attempts, last_error)
         VALUES (?, (SELECT id FROM lists LIMIT 1), ?, ?, ?, ?)`,
      )
      .run(id, status, 'a'.repeat(64), attempts, lastError);
    return id;
  } finally {
    database.close();
  }
}

function storedReceipt(id: string): Record<string, unknown> {
  const database = openSqliteDatabase(databasePath);
  try {
    return database
      .prepare('SELECT status, attempts, last_error FROM receipts WHERE id = ?')
      .get(id) as Record<string, unknown>;
  } finally {
    database.close();
  }
}

/** Run a retry request through the server hook and then the retry route. */
async function submit(
  id: string,
  options: { origin?: string | null } = {},
): Promise<Response> {
  const headers = new Headers({ host, 'content-type': 'application/json' });
  const requestOrigin = options.origin === undefined ? origin : options.origin;
  if (requestOrigin !== null) headers.set('origin', requestOrigin);
  const request = new Request(`${origin}/api/receipts/${id}/retry`, {
    method: 'POST',
    headers,
  });
  const event = {
    request,
    url: new URL(request.url),
    params: { id },
  } as unknown as RetryEvent;
  return handle({ event, resolve: async () => POST(event) });
}

describe('POST /api/receipts/[id]/retry', () => {
  it('resets a failed receipt to pending', async () => {
    const id = insertReceipt('failed', 3, 'the sidecar is unreachable');

    const response = await submit(id);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ id, status: 'pending' });
    expect(storedReceipt(id)).toEqual({
      status: 'pending',
      attempts: 0,
      last_error: 'the sidecar is unreachable',
    });
  });

  it('rejects a receipt that is not failed', async () => {
    const id = insertReceipt('review', 1, null);

    const response = await submit(id);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'INVALID_STATUS' },
    });
    expect(storedReceipt(id)).toMatchObject({ status: 'review', attempts: 1 });
  });

  it('reports an unknown receipt', async () => {
    const response = await submit(randomUUID());

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });

  it('still rejects a cross-origin retry through the hook', async () => {
    const id = insertReceipt('failed', 3, 'the sidecar is unreachable');

    const response = await submit(id, { origin: 'https://evil.example' });

    expect(response.status).toBe(403);
    expect(storedReceipt(id)).toMatchObject({ status: 'failed', attempts: 3 });
  });
});
