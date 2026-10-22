import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateAndBootstrap } from '../../src/lib/server/db/lifecycle.js';
import { openSqliteDatabase } from '../../src/lib/server/db/sqlite.js';
import { getServerInstanceId } from '../../src/lib/server/instance';
import { createHttpOcrEngine } from '../../src/lib/server/receipts/ocr-engine';
import {
  retryReceipt,
  runReceiptWorkerTick,
} from '../../src/lib/server/services/receipt-worker';

type Database = ReturnType<typeof openSqliteDatabase>;
type Row = Record<string, unknown>;

let directory: string;
let storageDir: string;
let database: Database;
let listId: string;
let server: Server | undefined;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'shopping-list-worker-http-'));
  storageDir = join(directory, 'receipts');
  mkdirSync(storageDir, { recursive: true });
  database = openSqliteDatabase(join(directory, 'shopping-list.sqlite'));
  migrateAndBootstrap(database, resolve(process.cwd(), 'migrations'));
  listId = (database.prepare('SELECT id FROM lists LIMIT 1').get() as Row)
    .id as string;
  process.env.CANONICAL_ORIGIN = 'http://localhost:5173';
});

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((closed) => {
    if (!server) return closed();
    server.close(() => closed());
  });
  server = undefined;
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

function insertPendingReceipt(): string {
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO receipts
         (id, list_id, status, sha256, image_path, image_bytes)
       VALUES (?, ?, 'pending', ?, ?, 16)`,
    )
    .run(id, listId, 'a'.repeat(64), `${id}.jpg`);
  writeFileSync(join(storageDir, `${id}.jpg`), 'fake-image-bytes');
  return id;
}

function receiptRow(id: string): Row {
  return database
    .prepare(
      'SELECT status, attempts, ocr_json, last_error FROM receipts WHERE id = ?',
    )
    .get(id) as Row;
}

/** Start a loopback OCR stand-in; returns its `POST /ocr` URL. */
async function startOcrServer(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    body: Buffer,
  ) => void,
): Promise<string> {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => handler(request, response, Buffer.concat(chunks)));
  });
  await new Promise<void>((listening) =>
    server?.listen(0, '127.0.0.1', () => listening()),
  );
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/ocr`;
}

function tickWith(url: string, timeoutMs = 5000) {
  return runReceiptWorkerTick({
    database,
    storageDir,
    engine: createHttpOcrEngine({ url, timeoutMs }),
  });
}

describe('worker against a real OCR endpoint', () => {
  it('posts the stored image bytes and records the returned payload', async () => {
    const id = insertPendingReceipt();
    const payload = '{"pages":[{"lines":[{"text":"MILK","conf":0.9}]}]}';
    let seen: Row = {};

    const url = await startOcrServer((request, response, body) => {
      seen = {
        method: request.method,
        contentType: request.headers['content-type'],
        authorization: request.headers.authorization,
        body: body.toString('utf8'),
      };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(payload);
    });

    expect(await tickWith(url)).toEqual({
      outcome: 'processed',
      receiptId: id,
    });
    expect(seen).toEqual({
      method: 'POST',
      contentType: 'image/jpeg',
      authorization: undefined,
      body: 'fake-image-bytes',
    });
    expect(receiptRow(id)).toMatchObject({
      status: 'review',
      attempts: 1,
      ocr_json: payload,
      last_error: null,
    });
  });

  it('sends the configured bearer token', async () => {
    const id = insertPendingReceipt();
    let authorization: string | undefined;

    const url = await startOcrServer((request, response) => {
      authorization = request.headers.authorization;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"pages":[]}');
    });

    await runReceiptWorkerTick({
      database,
      storageDir,
      engine: createHttpOcrEngine({
        url,
        token: 'shared-secret',
        timeoutMs: 5000,
      }),
    });

    expect(authorization).toBe('Bearer shared-secret');
    expect(receiptRow(id)).toMatchObject({ status: 'review' });
  });

  it('retries a sidecar error three times and then fails the receipt', async () => {
    const id = insertPendingReceipt();
    let requests = 0;

    const url = await startOcrServer((_request, response) => {
      requests += 1;
      response.writeHead(500);
      response.end('perception pipeline crashed');
    });

    expect(await tickWith(url)).toMatchObject({
      outcome: 'retry-scheduled',
      attempts: 1,
    });
    expect(await tickWith(url)).toMatchObject({
      outcome: 'retry-scheduled',
      attempts: 2,
    });
    expect(await tickWith(url)).toMatchObject({
      outcome: 'failed',
      attempts: 3,
    });

    expect(requests).toBe(3);
    expect(receiptRow(id)).toMatchObject({
      status: 'failed',
      attempts: 3,
      last_error: expect.stringContaining('HTTP 500') as unknown as string,
    });
  });

  it('reports an unreachable engine instead of hanging the queue', async () => {
    const id = insertPendingReceipt();
    // Reserve a port, then close it so the connection is refused.
    const url = await startOcrServer(() => {});
    server?.closeAllConnections();
    await new Promise<void>((closed) => server?.close(() => closed()));
    server = undefined;

    expect(await tickWith(url, 2000)).toMatchObject({
      outcome: 'retry-scheduled',
      attempts: 1,
    });
    expect(receiptRow(id).last_error).toContain(
      'Could not reach the OCR engine',
    );
  });

  it('fails boundedly when the sidecar rejects the token, then accepts it', async () => {
    const id = insertPendingReceipt();
    let requests = 0;

    const url = await startOcrServer((request, response) => {
      requests += 1;
      if (request.headers.authorization !== 'Bearer shared-secret') {
        response.writeHead(401);
        response.end('a valid bearer token is required');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"pages":[]}');
    });

    // A token-protected sidecar rejects the unauthenticated worker three times
    // and the receipt ends up failed with the reason visible.
    for (const attempts of [1, 2]) {
      expect(await tickWith(url)).toMatchObject({
        outcome: 'retry-scheduled',
        attempts,
      });
    }
    expect(await tickWith(url)).toMatchObject({
      outcome: 'failed',
      attempts: 3,
    });
    expect(receiptRow(id)).toMatchObject({
      status: 'failed',
      last_error: expect.stringContaining('HTTP 401') as unknown as string,
    });

    // Manual retry with the shared token completes the same receipt.
    retryReceipt(id, { serverInstanceId: getServerInstanceId() }, database);
    expect(
      await runReceiptWorkerTick({
        database,
        storageDir,
        engine: createHttpOcrEngine({
          url,
          token: 'shared-secret',
          timeoutMs: 5000,
        }),
      }),
    ).toEqual({ outcome: 'processed', receiptId: id });
    expect(receiptRow(id)).toMatchObject({
      status: 'review',
      last_error: null,
    });
    expect(requests).toBe(4);
  });

  it('times out a sidecar that never answers', async () => {
    const id = insertPendingReceipt();

    const url = await startOcrServer(() => {
      // Never respond: the engine's own timeout has to end the request.
    });

    expect(await tickWith(url, 100)).toMatchObject({
      outcome: 'retry-scheduled',
      attempts: 1,
    });
    expect(receiptRow(id).last_error).toContain('timed out');
  });
});
