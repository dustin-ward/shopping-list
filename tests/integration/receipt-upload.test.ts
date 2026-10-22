import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateAndBootstrap } from '../../src/lib/server/db/lifecycle.js';
import { openSqliteDatabase } from '../../src/lib/server/db/sqlite.js';
import { getServerInstanceId } from '../../src/lib/server/instance';
import {
  acceptReceiptUpload,
  MAX_RECEIPT_IMAGE_BYTES,
} from '../../src/lib/server/services/receipts';

type Database = ReturnType<typeof openSqliteDatabase>;
type Row = Record<string, unknown>;

const UPLOAD_URL = 'http://localhost:5173/api/receipts';

const MAGIC: Record<'jpeg' | 'png' | 'webp', Buffer> = {
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  webp: Buffer.concat([
    Buffer.from('RIFF', 'latin1'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'latin1'),
  ]),
};

let directory: string;
let storageDir: string;
let database: Database;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'shopping-list-upload-'));
  storageDir = join(directory, 'receipts');
  database = openSqliteDatabase(join(directory, 'shopping-list.sqlite'));
  migrateAndBootstrap(database, resolve(process.cwd(), 'migrations'));
});

afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

function imageBytes(format: 'jpeg' | 'png' | 'webp', size = 256): Buffer {
  const magic = MAGIC[format];
  return Buffer.concat([
    magic,
    Buffer.alloc(Math.max(size - magic.length, 0), 0x42),
  ]);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A plain ArrayBuffer-backed view, as BodyInit/BlobPart expect. */
function bodyInit(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function uploadRequest(
  bytes: Uint8Array,
  filename = 'receipt.jpg',
  type = 'image/jpeg',
): Request {
  const body = new FormData();
  body.set('image', new Blob([bodyInit(bytes)], { type }), filename);
  return new Request(UPLOAD_URL, {
    method: 'POST',
    body,
    headers: { 'x-server-instance-id': getServerInstanceId() },
  });
}

function upload(bytes: Uint8Array, filename?: string, type?: string) {
  return acceptReceiptUpload(
    uploadRequest(bytes, filename, type),
    database,
    storageDir,
  );
}

function receiptRows(): Row[] {
  return database
    .prepare(
      'SELECT id, status, image_path, image_bytes, sha256 FROM receipts ORDER BY created_at, id',
    )
    .all() as Row[];
}

function storageFiles(): string[] {
  return existsSync(storageDir) ? readdirSync(storageDir).sort() : [];
}

describe('receipt upload', () => {
  it('stores a valid image as a pending receipt with the file on disk', async () => {
    const bytes = imageBytes('jpeg');

    const result = await upload(bytes);

    expect(result).toEqual({
      id: expect.any(String),
      status: 'pending',
      alreadyCaptured: false,
    });

    const rows = receiptRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.id,
      status: 'pending',
      image_path: `${result.id}.jpg`,
      image_bytes: bytes.length,
      sha256: sha256(bytes),
    });

    const imagePath = join(storageDir, `${result.id}.jpg`);
    expect(existsSync(imagePath)).toBe(true);
    expect(readFileSync(imagePath).equals(bytes)).toBe(true);
    expect(storageFiles()).toEqual([`${result.id}.jpg`]);
  });

  it('accepts PNG and WebP payloads with their detected extensions', async () => {
    const png = await upload(imageBytes('png'), 'scan.png', 'image/png');
    const webp = await upload(imageBytes('webp'), 'scan.webp', 'image/webp');

    expect(png.status).toBe('pending');
    expect(webp.status).toBe('pending');
    expect(storageFiles()).toEqual([`${png.id}.png`, `${webp.id}.webp`].sort());
  });

  it('rejects an oversize image and writes nothing', async () => {
    const bytes = imageBytes('jpeg', MAX_RECEIPT_IMAGE_BYTES + 1);

    await expect(upload(bytes)).rejects.toMatchObject({
      status: 413,
      code: 'IMAGE_TOO_LARGE',
    });
    expect(receiptRows()).toEqual([]);
    expect(storageFiles()).toEqual([]);
  });

  it('rejects a request whose declared size exceeds the request limit', async () => {
    const body = new FormData();
    body.set(
      'image',
      new Blob([bodyInit(imageBytes('jpeg'))], { type: 'image/jpeg' }),
      'receipt.jpg',
    );
    const request = new Request(UPLOAD_URL, {
      method: 'POST',
      body,
      headers: {
        'content-length': String(MAX_RECEIPT_IMAGE_BYTES + 1024 * 1024),
        'x-server-instance-id': getServerInstanceId(),
      },
    });

    await expect(
      acceptReceiptUpload(request, database, storageDir),
    ).rejects.toMatchObject({ status: 413, code: 'REQUEST_TOO_LARGE' });
    expect(receiptRows()).toEqual([]);
    expect(storageFiles()).toEqual([]);
  });

  it('rejects payloads that fail the magic-byte check', async () => {
    const bytes = Buffer.from('GIF89a this is not a receipt photo', 'latin1');

    await expect(
      upload(bytes, 'receipt.gif', 'image/gif'),
    ).rejects.toMatchObject({ status: 415, code: 'UNSUPPORTED_IMAGE' });
    expect(receiptRows()).toEqual([]);
    expect(storageFiles()).toEqual([]);
  });

  it('rejects a multipart body with no image part', async () => {
    const body = new FormData();
    body.set('capturedAt', '2026-10-17T12:00:00.000Z');
    const request = new Request(UPLOAD_URL, {
      method: 'POST',
      body,
      headers: { 'x-server-instance-id': getServerInstanceId() },
    });

    await expect(
      acceptReceiptUpload(request, database, storageDir),
    ).rejects.toMatchObject({ status: 400, code: 'MISSING_IMAGE' });
    expect(receiptRows()).toEqual([]);
    expect(storageFiles()).toEqual([]);
  });

  it('rejects a request that is not multipart/form-data', async () => {
    const request = new Request(UPLOAD_URL, {
      method: 'POST',
      body: bodyInit(imageBytes('jpeg')),
      headers: {
        'content-type': 'image/jpeg',
        'x-server-instance-id': getServerInstanceId(),
      },
    });

    await expect(
      acceptReceiptUpload(request, database, storageDir),
    ).rejects.toMatchObject({ status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });
    expect(receiptRows()).toEqual([]);
  });

  it('returns the existing receipt for duplicate bytes without a second row or file', async () => {
    const bytes = imageBytes('png');
    const first = await upload(bytes, 'first.png', 'image/png');

    const second = await upload(bytes, 'second.png', 'image/png');

    expect(second).toEqual({
      id: first.id,
      status: 'pending',
      alreadyCaptured: true,
    });
    expect(receiptRows()).toHaveLength(1);
    expect(storageFiles()).toEqual([`${first.id}.png`]);
  });

  it('dedupes against any non-discarded receipt state', async () => {
    const bytes = imageBytes('jpeg');
    const first = await upload(bytes);
    database
      .prepare("UPDATE receipts SET status = 'review' WHERE id = ?")
      .run(first.id);

    const second = await upload(bytes);

    expect(second).toEqual({
      id: first.id,
      status: 'review',
      alreadyCaptured: true,
    });
    expect(receiptRows()).toHaveLength(1);
  });

  it('accepts the same bytes again after the previous receipt is discarded', async () => {
    const bytes = imageBytes('jpeg');
    const first = await upload(bytes);
    database
      .prepare(
        "UPDATE receipts SET status = 'discarded', image_path = NULL WHERE id = ?",
      )
      .run(first.id);
    rmSync(join(storageDir, `${first.id}.jpg`), { force: true });

    const second = await upload(bytes);

    expect(second.id).not.toBe(first.id);
    expect(second.alreadyCaptured).toBe(false);
    expect(receiptRows()).toHaveLength(2);
    expect(storageFiles()).toEqual([`${second.id}.jpg`]);
  });

  it('leaves no temp files behind when a later upload is rejected', async () => {
    await upload(imageBytes('jpeg'));
    await expect(
      upload(Buffer.from('not an image', 'latin1'), 'bad.jpg', 'image/jpeg'),
    ).rejects.toMatchObject({ status: 415 });

    expect(
      storageFiles().filter((name) => name.startsWith('.incoming-')),
    ).toEqual([]);
    expect(receiptRows()).toHaveLength(1);
  });

  it('assigns a fresh id on every accepted upload', async () => {
    const first = await upload(imageBytes('jpeg'));
    const second = await upload(imageBytes('jpeg', 512));

    expect(first.id).not.toBe(second.id);
    expect(storageFiles()).toHaveLength(2);
  });

  it('drains the request body after the image part so the response is not cut off', async () => {
    // Cancelling the request stream instead of draining it tears down the real
    // HTTP connection before the response is written, so the tail (a large
    // trailing field here) must be read to completion.
    const boundary = 'receiptBoundary123';
    const image = imageBytes('jpeg');
    const raw = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          'Content-Disposition: form-data; name="image"; filename="receipt.jpg"\r\n' +
          'Content-Type: image/jpeg\r\n\r\n',
      ),
      image,
      Buffer.from(
        `\r\n--${boundary}\r\n` +
          'Content-Disposition: form-data; name="note"\r\n\r\n',
      ),
      Buffer.alloc(4096, 0x5a),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= raw.length) {
          controller.close();
          return;
        }
        const end = Math.min(pulled + 128, raw.length);
        controller.enqueue(raw.subarray(pulled, end));
        pulled = end;
      },
    });
    const request = new Request(UPLOAD_URL, {
      method: 'POST',
      body,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'x-server-instance-id': getServerInstanceId(),
      },
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    const result = await acceptReceiptUpload(request, database, storageDir);

    expect(result.status).toBe('pending');
    expect(pulled).toBe(raw.length);
  });
});

describe('receipt upload id generation', () => {
  it('never uses a caller-supplied filename for the stored path', async () => {
    const result = await upload(
      imageBytes('jpeg'),
      '../../etc/passwd.jpg',
      'image/jpeg',
    );

    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(storageFiles()).toEqual([`${result.id}.jpg`]);
    expect(storageFiles()).not.toContain('passwd.jpg');
  });
});
