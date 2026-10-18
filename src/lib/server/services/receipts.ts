import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_GROUP_COLOR,
  receiptStatusSchema,
  type CommitReceiptInput,
  type ReceiptCapabilities,
  type ReceiptDetail,
  type ReceiptLine,
  type ReceiptListItem,
  type ReceiptListPage,
  type ReceiptStatus,
  type RepairReceiptInput,
  type UpdateReceiptInput,
} from '../../shared/schemas';
import { getConfig } from '../config.js';
import { getRawDatabase } from '../db/connection';
import { AppError, badRequest, conflict, notFound } from '../errors';
import {
  planReceiptCommit,
  type AliasLearning,
  type CommitPlan,
  type CommittableLine,
  type ExistingItem,
  type ItemRef,
  type LiveGroup,
} from '../receipts/commit-plan';
import { detectImageFormat } from '../receipts/image-format';
import {
  readMultipartFilePart,
  type MultipartFilePart,
} from '../receipts/multipart.js';
import { imageContentType } from '../receipts/ocr-engine';
import { ocrTextFromJson } from '../receipts/ocr-text';
import { suggestionsForLines } from '../receipts/matcher';
import type { ParsedReceipt } from '../receipts/parser';
import { planLineRepair, type LineAlias } from '../receipts/repair-plan';
import { resolveLineEdit, type EditableLine } from '../receipts/review-edits';
import { bindTierOneMatches, loadMatchContext } from './receipt-matching';
import {
  assertReceiptUpdatedAt,
  bumpSnapshotRevision,
  currentListId,
  getLiveGroup,
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
// Parsing. The worker writes what the parser read onto the receipt and its
// lines; `ocr_json` stays as the engine returned it, so any version can be
// re-derived later.
// ---------------------------------------------------------------------------

/**
 * Persist one parser run: the receipt's totals, currency, parse version and
 * warning list, plus one `receipt_lines` row per parsed line. Lines are
 * replaced wholesale so a re-parse cannot double them up. Caller supplies the
 * transaction: this must run in the same one that moves the receipt to
 * `review`, or a crash between them would leave a reviewable receipt with no
 * lines.
 *
 * Tier-1 bindings are applied here too, for the same reason: a receipt must
 * never be reviewable with an exact name or alias match sitting unbound. Only
 * the automatic binding is written; tier-2 candidates are computed on read.
 */
export function writeReceiptParse(
  database: SqliteDatabase,
  receiptId: string,
  parsed: ParsedReceipt,
  currency: string,
): void {
  const now = timestampNow();
  database
    .prepare(
      `UPDATE receipts
          SET subtotal_minor = ?, tax_minor = ?, total_minor = ?, currency = ?,
              parse_version = ?, ocr_warnings = ?
        WHERE id = ?`,
    )
    .run(
      parsed.subtotalMinor,
      parsed.taxMinor,
      parsed.totalMinor,
      currency,
      parsed.parseVersion,
      // A JSON array even when empty: `null` means "never parsed".
      JSON.stringify(parsed.warnings),
      receiptId,
    );

  database
    .prepare('DELETE FROM receipt_lines WHERE receipt_id = ?')
    .run(receiptId);
  const insert = database.prepare(
    `INSERT INTO receipt_lines
       (id, receipt_id, line_index, raw_text, parsed_name, quantity_real,
        quantity_text, quantity_unit, unit_price_minor, total_price_minor,
        is_item_chunk, confidence, review_state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unreviewed', ?, ?)`,
  );
  parsed.lines.forEach((line, lineIndex) => {
    insert.run(
      randomUUID(),
      receiptId,
      lineIndex,
      line.rawText,
      line.parsedName,
      line.quantityReal,
      line.quantityText,
      line.quantityUnit,
      line.unitPriceMinor,
      line.totalPriceMinor,
      line.isItemChunk ? 1 : 0,
      line.confidence,
      now,
      now,
    );
  });

  bindTierOneMatches(database, receiptId);
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
 * Receipt fields plus its lines, per-line suggestion candidates and
 * image-availability flag. The client polls this while the receipt is
 * `pending`.
 *
 * Suggestions are computed on read rather than stored: they are a pure
 * function of the lines and what the list currently knows, so a newly learned
 * alias or a renamed item is reflected the next time the receipt is opened —
 * and nothing speculative lands in the schema (spec §3: three tables).
 * Tier-1 lines still arrive bound, because that binding *is* persisted.
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

  const suggestions = suggestionsForLines(
    lines.map(mapLine),
    loadMatchContext(database, listId, row.store_group_id),
  );

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
    lines: lines.map((line) => ({
      ...mapLine(line),
      suggestions: suggestions.get(line.id) ?? [],
    })),
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
 * Apply the review editor's edits (plan §8 PATCH contract) in one transaction.
 *
 * Only a receipt in `review` is editable — committed receipts are immutable in
 * R1 — and the caller's `updatedAt` must match the stored one, so a stale edit
 * is refused instead of silently clobbering a newer one. Lines are validated
 * against this receipt, item lines only (parked rows are parser-settled), and
 * the state/binding rules live in `resolveLineEdit`. The fresh detail comes
 * back so the editor can replace its copy without a second round trip.
 */
export function updateReceipt(
  receiptId: string,
  input: UpdateReceiptInput,
  database: SqliteDatabase = getRawDatabase(),
  config = getConfig(),
): ReceiptDetail {
  const listId = currentListId(database);

  return runWriteTransaction(database, () => {
    const row = database
      .prepare(
        `SELECT id, status, updated_at FROM receipts
          WHERE id = ? AND list_id = ?`,
      )
      .get(receiptId, listId) as
      { id: string; status: ReceiptStatus; updated_at: string } | undefined;
    if (!row) throw notFound('Receipt not found.');
    if (row.status !== 'review') {
      throw conflict(
        'RECEIPT_NOT_EDITABLE',
        `Only a receipt in review can be edited; this one is ${row.status}.`,
        { status: row.status },
      );
    }
    assertReceiptUpdatedAt(receiptId, row.updated_at, input.expectedUpdatedAt);

    if (
      input.currency !== undefined &&
      input.currency !== config.receiptCurrency
    ) {
      throw badRequest(
        'INVALID_CURRENCY',
        `Receipts are recorded in ${config.receiptCurrency}.`,
      );
    }
    if (input.storeGroupId) {
      const group = getLiveGroup(database, listId, input.storeGroupId);
      if (!group || group.kind !== 'store') {
        throw new AppError(
          400,
          'INVALID_STORE',
          'Choose a store from this list.',
          { fieldErrors: { storeGroupId: ['Choose a store group.'] } },
        );
      }
    }

    const now = timestampNow();
    let changed = false;

    for (const linePatch of input.lines ?? []) {
      const lineRow = database
        .prepare(
          `SELECT id, raw_text, quantity_real, quantity_text, quantity_unit,
                  unit_price_minor, total_price_minor, review_state,
                  catalog_item_id, bound_via, bound_rank, is_item_chunk
             FROM receipt_lines
            WHERE id = ? AND receipt_id = ?`,
        )
        .get(linePatch.id, receiptId) as
        (EditableLineRow & { is_item_chunk: number }) | undefined;
      if (!lineRow?.is_item_chunk) {
        throw badRequest(
          'INVALID_LINE',
          'Only an item line on this receipt can be edited.',
        );
      }

      const resolved = resolveLineEdit(toEditableLine(lineRow), linePatch);
      if (resolved.catalogItemId) {
        requireLiveCatalogItem(database, listId, resolved.catalogItemId);
      }
      database
        .prepare(
          `UPDATE receipt_lines
              SET raw_text = ?, quantity_real = ?, quantity_text = ?,
                  quantity_unit = ?, unit_price_minor = ?, total_price_minor = ?,
                  review_state = ?, catalog_item_id = ?, bound_via = ?,
                  bound_rank = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          resolved.rawText,
          resolved.quantityReal,
          resolved.quantityText,
          resolved.quantityUnit,
          resolved.unitPriceMinor,
          resolved.totalPriceMinor,
          resolved.reviewState,
          resolved.catalogItemId,
          resolved.boundVia,
          resolved.boundRank,
          now,
          linePatch.id,
        );
      changed = true;
    }

    if (applyReceiptFields(database, receiptId, input)) changed = true;

    // The guard token is the receipt's `updated_at`, so every accepted edit
    // moves it — including the edits that only touched a line.
    if (changed) {
      database
        .prepare('UPDATE receipts SET updated_at = ? WHERE id = ?')
        .run(now, receiptId);
    }

    return getReceiptDetail(receiptId, database);
  });
}

/** The receipt-level corrections, or `false` when the patch carried none. */
function applyReceiptFields(
  database: SqliteDatabase,
  receiptId: string,
  input: UpdateReceiptInput,
): boolean {
  const assignments: string[] = [];
  const values: unknown[] = [];
  const columns: [keyof UpdateReceiptInput, string][] = [
    ['storeGroupId', 'store_group_id'],
    ['currency', 'currency'],
    ['subtotalMinor', 'subtotal_minor'],
    ['taxMinor', 'tax_minor'],
    ['totalMinor', 'total_minor'],
  ];
  for (const [field, column] of columns) {
    if (input[field] === undefined) continue;
    assignments.push(`${column} = ?`);
    values.push(input[field]);
  }
  if (!assignments.length) return false;

  database
    .prepare(`UPDATE receipts SET ${assignments.join(', ')} WHERE id = ?`)
    .run(...values, receiptId);
  return true;
}

/** One stored line as it comes out of SQLite, before it is resolved. */
type EditableLineRow = {
  raw_text: string;
  quantity_real: number | null;
  quantity_text: string | null;
  quantity_unit: EditableLine['quantityUnit'];
  unit_price_minor: number | null;
  total_price_minor: number | null;
  review_state: EditableLine['reviewState'];
  catalog_item_id: string | null;
  bound_via: EditableLine['boundVia'];
  bound_rank: number | null;
};

/** The row read in the shape the edit rules speak. */
function toEditableLine(row: EditableLineRow): EditableLine {
  return {
    rawText: row.raw_text,
    quantityReal: row.quantity_real,
    quantityText: row.quantity_text,
    quantityUnit: row.quantity_unit,
    unitPriceMinor: row.unit_price_minor,
    totalPriceMinor: row.total_price_minor,
    reviewState: row.review_state,
    catalogItemId: row.catalog_item_id,
    boundVia: row.bound_via,
    boundRank: row.bound_rank,
  };
}

function requireLiveCatalogItem(
  database: SqliteDatabase,
  listId: string,
  catalogItemId: string,
): void {
  const item = database
    .prepare('SELECT id FROM catalog_items WHERE id = ? AND list_id = ?')
    .get(catalogItemId, listId) as { id: string } | undefined;
  if (!item) {
    throw new AppError(400, 'INVALID_ITEM', 'Choose an item from this list.', {
      fieldErrors: { catalogItemId: ['Choose an item from this list.'] },
    });
  }
}

// ---------------------------------------------------------------------------
// The write path. Commit is the only way a receipt's rows become canonical
// data; discard is the one deliberate deletion.
// ---------------------------------------------------------------------------

/**
 * Commit one reviewed receipt: validate the gate, materialize the reviewer's
 * drafts, bind the lines, learn the aliases, and mark the receipt committed —
 * all inside one immediate transaction, so a refusal or a crash leaves the
 * receipt exactly as it was.
 *
 * Only a receipt in `review` can be committed; a second commit is a conflict,
 * not a re-run. The plan (`receipts/commit-plan.ts`) decides everything; this
 * function only writes it.
 */
export function commitReceipt(
  receiptId: string,
  input: CommitReceiptInput,
  database: SqliteDatabase = getRawDatabase(),
): ReceiptDetail {
  const listId = currentListId(database);

  return runWriteTransaction(database, () => {
    const row = database
      .prepare(
        `SELECT id, status, updated_at AS updatedAt,
                store_group_id AS storeGroupId
           FROM receipts
          WHERE id = ? AND list_id = ?`,
      )
      .get(receiptId, listId) as
      | {
          id: string;
          status: ReceiptStatus;
          updatedAt: string;
          storeGroupId: string | null;
        }
      | undefined;
    if (!row) throw notFound('Receipt not found.');
    if (row.status === 'committed') {
      throw conflict(
        'RECEIPT_ALREADY_COMMITTED',
        'This receipt is already committed.',
        { status: row.status },
      );
    }
    if (row.status !== 'review') {
      throw conflict(
        'RECEIPT_NOT_COMMITTABLE',
        `Only a receipt in review can be committed; this one is ${row.status}.`,
        { status: row.status },
      );
    }
    // The guard every review edit carries: a commit made from a stale view would
    // gate and materialize lines the reviewer has since changed.
    assertReceiptUpdatedAt(receiptId, row.updatedAt, input.expectedUpdatedAt);

    const plan = planReceiptCommit({
      lines: loadCommittableLines(database, receiptId),
      itemDrafts: input.itemDrafts ?? [],
      storeGroupId: row.storeGroupId,
      storeDraft: input.storeDraft ?? null,
      items: database
        .prepare(
          `SELECT id, normalized_name AS normalizedName
             FROM catalog_items
            WHERE list_id = ?
            ORDER BY normalized_name, id`,
        )
        .all(listId) as ExistingItem[],
      groups: database
        .prepare(
          `SELECT id, normalized_name AS normalizedName, kind
             FROM groups
            WHERE list_id = ? AND archived_at IS NULL
            ORDER BY position, id`,
        )
        .all(listId) as LiveGroup[],
    });

    writeCommitPlan(database, listId, receiptId, plan);
    return getReceiptDetail(receiptId, database);
  });
}

/**
 * Execute a plan: create the items and the store it asked for, bind the lines,
 * learn the aliases, commit the receipt — and bump the snapshot revision only
 * when it created something the snapshot carries.
 */
function writeCommitPlan(
  database: SqliteDatabase,
  listId: string,
  receiptId: string,
  plan: CommitPlan,
): void {
  const now = timestampNow();
  const createdItems = new Map<string, string>();
  for (const item of plan.newItems) {
    const id = randomUUID();
    database
      .prepare(
        `INSERT INTO catalog_items (id, list_id, display_name, normalized_name)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, listId, item.name, item.normalizedName);
    createdItems.set(item.normalizedName, id);
  }

  const storeGroupId =
    plan.store.kind === 'existing'
      ? plan.store.groupId
      : createStoreGroup(
          database,
          listId,
          plan.store.normalizedName,
          plan.store.name,
        );

  const resolveItem = (item: ItemRef): string => {
    const id =
      item.kind === 'existing'
        ? item.id
        : createdItems.get(item.normalizedName);
    if (!id) {
      throw new AppError(
        500,
        'COMMIT_PLAN_INVALID',
        'The commit plan referred to an item that was never created.',
      );
    }
    return id;
  };

  const bind = database.prepare(
    `UPDATE receipt_lines
        SET catalog_item_id = ?, review_state = 'new', bound_via = ?,
            bound_rank = NULL, updated_at = ?
      WHERE id = ? AND receipt_id = ?`,
  );
  for (const write of plan.lineWrites) {
    // The line keeps the reviewer's `new` state — that is what they did — while
    // `bound_via` records where the binding came from.
    bind.run(
      resolveItem(write.item),
      write.boundVia,
      now,
      write.lineId,
      receiptId,
    );
  }

  for (const alias of plan.aliases) {
    learnAlias(database, listId, resolveItem(alias.item), alias, now);
  }

  database
    .prepare(
      `UPDATE receipts
          SET status = 'committed', store_group_id = ?, committed_at = ?,
              last_error = NULL, updated_at = ?
        WHERE id = ? AND list_id = ?`,
    )
    .run(storeGroupId, now, now, receiptId, listId);

  // Receipts and aliases stay out of the snapshot: only a created item or store
  // group is something the rest of the app has to hear about.
  if (plan.createsEntities) bumpSnapshotRevision(database, now);
}

/** A store group as the Groups screen would create one: store kind, live position. */
function createStoreGroup(
  database: SqliteDatabase,
  listId: string,
  normalizedName: string,
  name: string,
): string {
  const position = database
    .prepare(
      `SELECT COALESCE(MAX(position), -1) + 1 AS position
         FROM groups
        WHERE list_id = ? AND archived_at IS NULL`,
    )
    .get(listId) as { position: number };
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO groups (id, list_id, name, normalized_name, kind, color, position)
       VALUES (?, ?, ?, ?, 'store', ?, ?)`,
    )
    .run(
      id,
      listId,
      name,
      normalizedName,
      DEFAULT_GROUP_COLOR,
      position.position,
    );
  return id;
}

/**
 * Learn one alias from a reviewed line, at most once per item and phrase: a
 * phrase the item already answers to is left alone, a soft-deleted row is
 * revived (relearning is what revives it), and anything else is a new row. A
 * revival is a review whatever wrote the row first, so `source` is rewritten
 * with the rest — matching only ever binds from a human-confirmed alias.
 */
function learnAlias(
  database: SqliteDatabase,
  listId: string,
  catalogItemId: string,
  alias: Omit<AliasLearning, 'item'>,
  now: string,
): void {
  const live = database
    .prepare(
      `SELECT id FROM item_aliases
        WHERE list_id = ? AND catalog_item_id = ? AND normalized_alias = ?
          AND deleted_at IS NULL`,
    )
    .get(listId, catalogItemId, alias.normalizedAlias);
  if (live) return;

  const revived = database
    .prepare(
      `UPDATE item_aliases
          SET alias_text = ?, source = 'review',
              created_by_receipt_line_id = ?, deleted_at = NULL, updated_at = ?
        WHERE id = (
                SELECT id FROM item_aliases
                 WHERE list_id = ? AND catalog_item_id = ? AND normalized_alias = ?
                   AND deleted_at IS NOT NULL
                 ORDER BY id
                 LIMIT 1
              )`,
    )
    .run(
      alias.aliasText,
      alias.lineId,
      now,
      listId,
      catalogItemId,
      alias.normalizedAlias,
    );
  if (revived.changes > 0) return;

  database
    .prepare(
      `INSERT INTO item_aliases
         (id, list_id, catalog_item_id, alias_text, normalized_alias, source,
          created_by_receipt_line_id)
       VALUES (?, ?, ?, ?, ?, 'review', ?)`,
    )
    .run(
      randomUUID(),
      listId,
      catalogItemId,
      alias.aliasText,
      alias.normalizedAlias,
      alias.lineId,
    );
}

type CommittableLineRow = {
  id: string;
  raw_text: string;
  is_item_chunk: number;
  review_state: ReceiptLine['reviewState'];
  catalog_item_id: string | null;
};

/** The lines commit reads: parked rows included, in the order they were printed. */
function loadCommittableLines(
  database: SqliteDatabase,
  receiptId: string,
): CommittableLine[] {
  const rows = database
    .prepare(
      `SELECT id, raw_text, is_item_chunk, review_state, catalog_item_id
         FROM receipt_lines
        WHERE receipt_id = ?
        ORDER BY line_index, id`,
    )
    .all(receiptId) as CommittableLineRow[];

  return rows.map((row) => ({
    id: row.id,
    rawText: row.raw_text,
    isItemChunk: Boolean(row.is_item_chunk),
    reviewState: row.review_state,
    catalogItemId: row.catalog_item_id,
  }));
}

/**
 * Discard one receipt: mark it discarded, purge its image, and keep everything
 * read from it (OCR JSON and lines) as the audit trail. Allowed from any
 * non-committed status — a committed receipt is canonical data in R1 — and
 * idempotent, since a second discard has nothing left to do. Discarded receipts
 * leave the lists, the price history and the upload dedupe; their `sha256` is
 * kept, so the same bytes can be captured again.
 *
 * The image is purged *after* the row is committed as discarded, never inside
 * the transaction: a rollback cannot bring a deleted file back, so a failure
 * must leave a stray file rather than a row pointing at nothing
 * (`ADR 0001` — destroying raw data is the one unrecoverable mistake).
 */
export function discardReceipt(
  receiptId: string,
  database: SqliteDatabase = getRawDatabase(),
  storageDir: string = getConfig().receiptStorageDir,
): ReceiptDetail {
  const listId = currentListId(database);

  const purge = runWriteTransaction(database, () => {
    const row = database
      .prepare(
        `SELECT id, status, image_path AS imagePath
           FROM receipts
          WHERE id = ? AND list_id = ?`,
      )
      .get(receiptId, listId) as
      | { id: string; status: ReceiptStatus; imagePath: string | null }
      | undefined;
    if (!row) throw notFound('Receipt not found.');
    if (row.status === 'committed') {
      throw conflict(
        'RECEIPT_COMMITTED',
        'A committed receipt cannot be discarded.',
        { status: row.status },
      );
    }
    if (row.status === 'discarded') return null;

    database
      .prepare(
        `UPDATE receipts
            SET status = 'discarded', image_path = NULL, image_bytes = NULL,
                updated_at = ?
          WHERE id = ? AND list_id = ?`,
      )
      .run(timestampNow(), receiptId, listId);

    return row.imagePath;
  });

  if (purge) rmSync(join(storageDir, purge), { force: true });

  return getReceiptDetail(receiptId, database);
}

// ---------------------------------------------------------------------------
// Repair. A committed receipt is canonical data, so correcting a line's binding
// is a deliberate act of its own rather than a review edit the PATCH route would
// take (ticket 16). Everything raw stays: only the binding moves.
// ---------------------------------------------------------------------------

/**
 * Correct the binding of one or more lines on a committed receipt, in one
 * transaction. Only a committed receipt can be repaired — the review `PATCH`
 * stays review-only, so the two write paths never overlap — and the caller's
 * `updatedAt` must match, as it must for every other write to a receipt.
 *
 * The consequences are what make a repair more than a column write: the aliases
 * the repaired line taught for another item stop binding, and the corrected
 * binding teaches its printed text (`planLineRepair`), so price history and
 * alias state both follow the correction. `display_name`, `raw_text`,
 * `ocr_json` and the image are untouched, and a repair creates nothing
 * snapshot-visible — it never moves `app_state.revision`.
 */
export function repairReceipt(
  receiptId: string,
  input: RepairReceiptInput,
  database: SqliteDatabase = getRawDatabase(),
): ReceiptDetail {
  const listId = currentListId(database);

  return runWriteTransaction(database, () => {
    const row = database
      .prepare(
        `SELECT id, status, updated_at AS updatedAt FROM receipts
          WHERE id = ? AND list_id = ?`,
      )
      .get(receiptId, listId) as
      { id: string; status: ReceiptStatus; updatedAt: string } | undefined;
    if (!row) throw notFound('Receipt not found.');
    if (row.status !== 'committed') {
      throw conflict(
        'RECEIPT_NOT_COMMITTED',
        `Only a committed receipt can be repaired; this one is ${row.status}.`,
        { status: row.status },
      );
    }
    assertReceiptUpdatedAt(receiptId, row.updatedAt, input.expectedUpdatedAt);

    const now = timestampNow();
    for (const patch of input.lines) {
      const lineRow = database
        .prepare(
          `SELECT id, raw_text, quantity_real, quantity_text, quantity_unit,
                  unit_price_minor, total_price_minor, review_state,
                  catalog_item_id, bound_via, bound_rank, is_item_chunk
             FROM receipt_lines
            WHERE id = ? AND receipt_id = ?`,
        )
        .get(patch.id, receiptId) as
        (EditableLineRow & { id: string; is_item_chunk: number }) | undefined;
      if (!lineRow?.is_item_chunk) {
        throw badRequest(
          'INVALID_LINE',
          'Only an item line on this receipt can be repaired.',
        );
      }

      const repair = planLineRepair(
        { id: lineRow.id, ...toEditableLine(lineRow) },
        patch,
        aliasesTaughtBy(database, listId, lineRow.id),
      );
      if (repair.catalogItemId) {
        requireLiveCatalogItem(database, listId, repair.catalogItemId);
      }

      database
        .prepare(
          `UPDATE receipt_lines
              SET review_state = ?, catalog_item_id = ?, bound_via = ?,
                  bound_rank = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          repair.reviewState,
          repair.catalogItemId,
          repair.boundVia,
          repair.boundRank,
          now,
          repair.lineId,
        );

      retractAliases(database, repair.retractAliasIds, now);
      if (repair.learnAlias && repair.catalogItemId) {
        learnAlias(
          database,
          listId,
          repair.catalogItemId,
          { lineId: repair.lineId, ...repair.learnAlias },
          now,
        );
      }
    }

    // The guard token is the receipt's `updated_at`, so every accepted repair
    // moves it — as every accepted review edit does.
    database
      .prepare('UPDATE receipts SET updated_at = ? WHERE id = ?')
      .run(now, receiptId);

    return getReceiptDetail(receiptId, database);
  });
}

/** The live aliases one line taught: the repair may retract these. */
function aliasesTaughtBy(
  database: SqliteDatabase,
  listId: string,
  lineId: string,
): LineAlias[] {
  return database
    .prepare(
      `SELECT id, catalog_item_id AS catalogItemId
         FROM item_aliases
        WHERE list_id = ? AND created_by_receipt_line_id = ? AND deleted_at IS NULL`,
    )
    .all(listId, lineId) as LineAlias[];
}

/**
 * Soft-delete the aliases the repaired line no longer backs. The row survives as
 * the audit trail (`ADR 0003`), and a row that was already deleted keeps its own
 * `deleted_at`: that timestamp is the record of when it stopped binding.
 */
function retractAliases(
  database: SqliteDatabase,
  aliasIds: readonly string[],
  now: string,
): void {
  const retract = database.prepare(
    `UPDATE item_aliases SET deleted_at = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL`,
  );
  for (const aliasId of aliasIds) retract.run(now, now, aliasId);
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
