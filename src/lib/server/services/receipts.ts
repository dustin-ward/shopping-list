import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  receiptStatusSchema,
  type ReceiptCapabilities,
  type ReceiptDetail,
  type ReceiptLine,
  type ReceiptListItem,
  type ReceiptListPage,
  type ReceiptStatus,
} from '../../shared/schemas';
import { getConfig } from '../config.js';
import { getRawDatabase } from '../db/connection';
import { AppError, notFound } from '../errors';
import { detectImageFormat } from '../receipts/image-format';
import {
  readMultipartFilePart,
  type MultipartFilePart,
} from '../receipts/multipart.js';
import { imageContentType } from '../receipts/ocr-engine';
import { ocrTextFromJson } from '../receipts/ocr-text';
import {
  currentListId,
  runWriteTransaction,
  timestampNow,
  type SqliteDatabase,
} from './common';

/** Route-enforced image cap; adapter-node's `BODY_SIZE_LIMIT` sits above it. */
export const MAX_RECEIPT_IMAGE_BYTES = 10 * 1024 * 1024;

/** List page size, matching purchase history's household-scale pagination. */
export const RECEIPT_LIST_PAGE_SIZE = 50;

export type { ReceiptStatus };

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

// ---------------------------------------------------------------------------
// Reads. Receipt data is fetched on demand and never enters the snapshot, so
// the Receipts tab polls these endpoints the way History polls purchases.
// ---------------------------------------------------------------------------

/** An item line the reviewer marked unknown; parked rows never count. */
const UNKNOWN_LINES_EXISTS = `EXISTS (
  SELECT 1 FROM receipt_lines l
   WHERE l.receipt_id = r.id AND l.is_item_chunk = 1 AND l.review_state = 'unknown'
)`;

const receiptColumns = `r.id, r.status, r.created_at, r.captured_at, r.currency,
  r.total_minor, r.store_group_id, r.last_error,
  (r.image_path IS NOT NULL) AS image_available,
  ${UNKNOWN_LINES_EXISTS} AS has_unknowns`;

type ReceiptRow = {
  id: string;
  status: ReceiptStatus;
  created_at: string;
  captured_at: string | null;
  currency: string | null;
  total_minor: number | null;
  store_group_id: string | null;
  image_available: number;
  has_unknowns: number;
  last_error: string | null;
};

type ReceiptDetailRow = ReceiptRow & {
  updated_at: string;
  processed_at: string | null;
  committed_at: string | null;
  subtotal_minor: number | null;
  tax_minor: number | null;
  parse_version: number;
  attempts: number;
  ocr_warnings: string | null;
  ocr_json: string | null;
};

type ReceiptLineRow = {
  id: string;
  line_index: number;
  raw_text: string;
  parsed_name: string | null;
  quantity_real: number | null;
  quantity_text: string | null;
  quantity_unit: ReceiptLine['quantityUnit'];
  unit_price_minor: number | null;
  total_price_minor: number | null;
  is_item_chunk: number;
  confidence: number | null;
  catalog_item_id: string | null;
  review_state: ReceiptLine['reviewState'];
  bound_via: ReceiptLine['boundVia'];
  bound_rank: number | null;
};

export type ReceiptListQuery = {
  /** Raw query-string values; validated here so routes stay thin. */
  status?: string | null;
  hasUnknowns?: string | null;
  cursor?: string | null;
};

/** Cursor-paginated receipt list, newest first, discarded rows excluded. */
export function listReceipts(
  query: ReceiptListQuery = {},
  database: SqliteDatabase = getRawDatabase(),
): ReceiptListPage {
  const status = parseStatusFilter(query.status);
  const hasUnknowns = parseHasUnknownsFilter(query.hasUnknowns);
  const cursor = decodeListCursor(query.cursor);
  const listId = currentListId(database);

  const conditions = ['r.list_id = ?', "r.status <> 'discarded'"];
  const parameters: unknown[] = [listId];
  if (status) {
    conditions.push('r.status = ?');
    parameters.push(status);
  }
  if (hasUnknowns === true) conditions.push(UNKNOWN_LINES_EXISTS);
  else if (hasUnknowns === false)
    conditions.push(`NOT ${UNKNOWN_LINES_EXISTS}`);
  if (cursor) {
    conditions.push('(r.created_at < ? OR (r.created_at = ? AND r.id < ?))');
    parameters.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  parameters.push(RECEIPT_LIST_PAGE_SIZE + 1);

  const rows = database
    .prepare(
      `SELECT ${receiptColumns}
         FROM receipts r
        WHERE ${conditions.join(' AND ')}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ?`,
    )
    .all(...parameters) as ReceiptRow[];

  const hasMore = rows.length > RECEIPT_LIST_PAGE_SIZE;
  const pageRows = rows.slice(0, RECEIPT_LIST_PAGE_SIZE);
  const lastRow = pageRows.at(-1);

  return {
    items: pageRows.map(mapListItem),
    nextCursor:
      hasMore && lastRow
        ? encodeListCursor({
            createdAt: lastRow.created_at,
            id: lastRow.id,
          })
        : null,
  };
}

/**
 * Receipt fields plus its lines and image-availability flag. The client polls
 * this while the receipt is `pending`; suggestions attach here in a later
 * ticket.
 */
export function getReceiptDetail(
  receiptId: string,
  database: SqliteDatabase = getRawDatabase(),
): ReceiptDetail {
  const listId = currentListId(database);
  const row = database
    .prepare(
      `SELECT ${receiptColumns}, r.updated_at, r.processed_at, r.committed_at,
              r.subtotal_minor, r.tax_minor, r.parse_version, r.attempts,
              r.ocr_warnings, r.ocr_json
         FROM receipts r
        WHERE r.id = ? AND r.list_id = ?`,
    )
    .get(receiptId, listId) as ReceiptDetailRow | undefined;
  if (!row) throw notFound('Receipt not found.');

  const lines = database
    .prepare(
      `SELECT id, line_index, raw_text, parsed_name, quantity_real,
              quantity_text, quantity_unit, unit_price_minor, total_price_minor,
              is_item_chunk, confidence, catalog_item_id, review_state,
              bound_via, bound_rank
         FROM receipt_lines
        WHERE receipt_id = ?
        ORDER BY line_index, id`,
    )
    .all(receiptId) as ReceiptLineRow[];

  return {
    ...mapListItem(row),
    updatedAt: row.updated_at,
    processedAt: row.processed_at,
    committedAt: row.committed_at,
    subtotalMinor: row.subtotal_minor,
    taxMinor: row.tax_minor,
    parseVersion: row.parse_version,
    attempts: row.attempts,
    ocrWarnings: row.ocr_warnings,
    ocrText: ocrTextFromJson(row.ocr_json),
    lines: lines.map(mapLine),
  };
}

export type ReceiptImage = { bytes: Uint8Array; contentType: string };

/**
 * The retained image for the blob-serving route. A discarded receipt has its
 * image purged, so no path (or a path whose file is gone) is simply "not
 * available" rather than an error worth logging.
 */
export function getReceiptImage(
  receiptId: string,
  database: SqliteDatabase = getRawDatabase(),
  storageDir: string = getConfig().receiptStorageDir,
): ReceiptImage {
  const listId = currentListId(database);
  const row = database
    .prepare('SELECT image_path FROM receipts WHERE id = ? AND list_id = ?')
    .get(receiptId, listId) as { image_path: string | null } | undefined;
  if (!row?.image_path) throw notFound('Receipt image is not available.');

  let bytes: Uint8Array;
  try {
    bytes = readFileSync(join(storageDir, row.image_path));
  } catch {
    throw notFound('Receipt image is not available.');
  }
  return { bytes, contentType: imageContentType(row.image_path) };
}

/**
 * The one flag the UI needs to decide whether capture (and therefore the tab)
 * exists at all. It is read from config per request, like everything else.
 */
export function getReceiptCapabilities(
  config = getConfig(),
): ReceiptCapabilities {
  return {
    enabled: Boolean(config.receiptOcrUrl),
    currency: config.receiptCurrency,
  };
}

function mapListItem(row: ReceiptRow): ReceiptListItem {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    capturedAt: row.captured_at,
    currency: row.currency,
    totalMinor: row.total_minor,
    storeGroupId: row.store_group_id,
    imageAvailable: Boolean(row.image_available),
    hasUnknowns: Boolean(row.has_unknowns),
    lastError: row.last_error,
  };
}

function mapLine(row: ReceiptLineRow): ReceiptLine {
  return {
    id: row.id,
    lineIndex: row.line_index,
    rawText: row.raw_text,
    parsedName: row.parsed_name,
    quantityReal: row.quantity_real,
    quantityText: row.quantity_text,
    quantityUnit: row.quantity_unit,
    unitPriceMinor: row.unit_price_minor,
    totalPriceMinor: row.total_price_minor,
    isItemChunk: Boolean(row.is_item_chunk),
    confidence: row.confidence,
    catalogItemId: row.catalog_item_id,
    reviewState: row.review_state,
    boundVia: row.bound_via,
    boundRank: row.bound_rank,
  };
}

const listCursorSchema = z.object({
  createdAt: z.string().min(1).max(40),
  id: z.uuid(),
});

type ReceiptListCursor = z.infer<typeof listCursorSchema>;

function decodeListCursor(
  cursor: string | null | undefined,
): ReceiptListCursor | null {
  if (!cursor) return null;
  if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) {
    throw invalidCursor();
  }

  try {
    const decoded = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as unknown;
    const result = listCursorSchema.safeParse(decoded);
    if (!result.success || Number.isNaN(Date.parse(result.data.createdAt))) {
      throw new Error('Invalid cursor fields.');
    }
    return result.data;
  } catch {
    throw invalidCursor();
  }
}

function encodeListCursor(cursor: ReceiptListCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function invalidCursor(): AppError {
  return new AppError(400, 'INVALID_CURSOR', 'The receipts cursor is invalid.');
}

function parseStatusFilter(
  value: string | null | undefined,
): ReceiptStatus | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = receiptStatusSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(400, 'INVALID_STATUS', 'That is not a receipt status.');
  }
  return parsed.data;
}

/** `null` means "no filter"; `false` means "exclude receipts with unknowns". */
function parseHasUnknownsFilter(
  value: string | null | undefined,
): boolean | null {
  if (value === undefined || value === null || value === '') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new AppError(
    400,
    'INVALID_FILTER',
    'The hasUnknowns filter must be true or false.',
  );
}
