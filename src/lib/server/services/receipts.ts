import { randomUUID } from 'node:crypto';
import { renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../config.js';
import { getRawDatabase } from '../db/connection';
import { AppError } from '../errors';
import { detectImageFormat } from '../receipts/image-format';
import {
  readMultipartFilePart,
  type MultipartFilePart,
} from '../receipts/multipart.js';
import {
  currentListId,
  runWriteTransaction,
  timestampNow,
  type SqliteDatabase,
} from './common';

/** Route-enforced image cap; adapter-node's `BODY_SIZE_LIMIT` sits above it. */
export const MAX_RECEIPT_IMAGE_BYTES = 10 * 1024 * 1024;

export type ReceiptStatus =
  'pending' | 'processing' | 'review' | 'committed' | 'discarded' | 'failed';

export type ReceiptUploadResult = {
  id: string;
  status: ReceiptStatus;
  alreadyCaptured: boolean;
};

type ExistingReceiptRow = { id: string; status: ReceiptStatus };

/**
 * Accept one multipart image upload: stream the part to disk, validate the
 * magic bytes, dedupe by sha256 against non-discarded receipts, and — only for
 * a genuinely new capture — store the image under the receipt storage
 * directory and insert a `pending` row.
 */
export async function acceptReceiptUpload(
  request: Request,
  database: SqliteDatabase = getRawDatabase(),
  storageDir: string = getConfig().receiptStorageDir,
): Promise<ReceiptUploadResult> {
  const part = await readMultipartFilePart(request, {
    tempDir: storageDir,
    maxBytes: MAX_RECEIPT_IMAGE_BYTES,
  });

  try {
    return storeUploadedReceipt(part, database, storageDir);
  } finally {
    rmSync(part.tempPath, { force: true });
  }
}

function storeUploadedReceipt(
  part: MultipartFilePart,
  database: SqliteDatabase,
  storageDir: string,
): ReceiptUploadResult {
  const format = detectImageFormat(part.magicBytes);
  if (!format) {
    throw new AppError(
      415,
      'UNSUPPORTED_IMAGE',
      'Upload a JPEG, PNG, or WebP receipt image.',
    );
  }

  const listId = currentListId(database);
  const now = timestampNow();
  const id = randomUUID();
  // Randomized stored name: the caller's filename never reaches the filesystem.
  const filename = `${id}.${format}`;
  const finalPath = join(storageDir, filename);

  return runWriteTransaction(database, () => {
    const existing = database
      .prepare(
        `SELECT id, status FROM receipts
         WHERE list_id = ? AND sha256 = ? AND status <> 'discarded'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(listId, part.sha256) as ExistingReceiptRow | undefined;
    if (existing) {
      return {
        id: existing.id,
        status: existing.status,
        alreadyCaptured: true,
      };
    }

    // Move the image into place before the insert so a failed write never
    // leaves a row pointing at a missing file; the catch below removes the file
    // again if the insert itself fails (a hard crash can at worst leak one file,
    // never a row without its image).
    renameSync(part.tempPath, finalPath);
    try {
      database
        .prepare(
          `INSERT INTO receipts
             (id, list_id, status, image_path, image_bytes, sha256, created_at, updated_at)
           VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
        )
        .run(id, listId, filename, part.bytes, part.sha256, now, now);
    } catch (error) {
      rmSync(finalPath, { force: true });
      throw error;
    }

    return { id, status: 'pending', alreadyCaptured: false };
  });
}
