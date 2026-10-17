import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../config.js';
import { getRawDatabase } from '../db/connection';
import { AppError, conflict, notFound } from '../errors';
import {
  createHttpOcrEngine,
  createStubOcrEngine,
  type OcrEngine,
} from '../receipts/ocr-engine';
import {
  currentListId,
  runWriteTransaction,
  timestampNow,
  type SqliteDatabase,
} from './common';
import type { ReceiptStatus } from './receipts';

/**
 * The queue worker. SQLite is the queue: one `pending` receipt is claimed per
 * tick inside an immediate transaction, handed to the OCR engine, and finished
 * as `review` or retried. Concurrency 1 is deliberate — household scale, no
 * races — and the claim's conditional UPDATE is what actually guarantees a
 * receipt is never processed twice, so a duplicated loop still cannot
 * double-process a row.
 */

/** A receipt gets at most three attempts; the third failure is terminal. */
export const MAX_RECEIPT_ATTEMPTS = 3;
/** Guard against storing an unbounded error (or a stack-shaped blob) in `last_error`. */
export const MAX_LAST_ERROR_LENGTH = 500;
/** `last_error` for a run that died mid-flight rather than reporting a failure. */
export const INTERRUPTED_LAST_ERROR =
  'OCR processing was interrupted before it finished.';

type RuntimeConfig = ReturnType<typeof getConfig>;

export type ClaimedReceipt = {
  id: string;
  imagePath: string | null;
  /** Attempts including this claim. */
  attempts: number;
};

export type ReceiptWorkerOptions = {
  database?: SqliteDatabase;
  storageDir?: string;
  /** Explicit engine (tests); otherwise derived from the configured OCR mode. */
  engine?: OcrEngine;
  maxAttempts?: number;
};

export type ReceiptWorkerOutcome =
  | { outcome: 'processed'; receiptId: string }
  | {
      outcome: 'retry-scheduled';
      receiptId: string;
      attempts: number;
      error: string;
    }
  | { outcome: 'failed'; receiptId: string; attempts: number; error: string }
  | { outcome: 'idle' }
  | { outcome: 'disabled' };

/**
 * Pick the engine for the runtime configuration. `RECEIPT_OCR_URL` unset means
 * the whole feature is off: no engine, no worker tick, no capture entry, while
 * existing receipts stay readable and reviewable.
 */
export function engineForConfig(config: RuntimeConfig): OcrEngine | undefined {
  if (!config.receiptOcrUrl) return undefined;
  if (config.receiptOcrMode === 'stub') return createStubOcrEngine();
  return createHttpOcrEngine({
    url: config.receiptOcrUrl,
    token: config.receiptOcrToken,
    timeoutMs: config.receiptOcrTimeoutMs,
  });
}

/**
 * Boot sweep: a `processing` row means the previous run was interrupted (this
 * app is the only writer, and only one replica runs). Send it back to the queue,
 * or fail it when the attempt cap is already spent.
 *
 * @returns how many rows were swept.
 */
export function sweepOrphanedReceipts(
  database: SqliteDatabase = getRawDatabase(),
  options: { maxAttempts?: number } = {},
): number {
  const result = database
    .prepare(
      `UPDATE receipts
          SET status = CASE
                WHEN attempts >= :maxAttempts THEN 'failed'
                ELSE 'pending'
              END,
              last_error = CASE
                WHEN attempts >= :maxAttempts
                  THEN COALESCE(last_error, :interrupted)
                ELSE last_error
              END,
              updated_at = :now
        WHERE status = 'processing'`,
    )
    .run({
      maxAttempts: options.maxAttempts ?? MAX_RECEIPT_ATTEMPTS,
      interrupted: INTERRUPTED_LAST_ERROR,
      now: timestampNow(),
    });

  return result.changes;
}

/**
 * Claim the oldest `pending` receipt, or `undefined` when the queue is empty.
 * The immediate transaction plus the `status = 'pending'` guard make the claim
 * exclusive even if two ticks run at once.
 */
export function claimNextPendingReceipt(
  database: SqliteDatabase = getRawDatabase(),
): ClaimedReceipt | undefined {
  return runWriteTransaction(database, () =>
    database
      .prepare(
        `UPDATE receipts
            SET status = 'processing', attempts = attempts + 1, updated_at = ?
          WHERE id = (
                  SELECT id FROM receipts
                   WHERE status = 'pending'
                   ORDER BY created_at, id
                   LIMIT 1
                )
            AND status = 'pending'
          RETURNING id, image_path AS imagePath, attempts`,
      )
      .get(timestampNow()),
  ) as ClaimedReceipt | undefined;
}

/**
 * Process at most one queued receipt. A failure that still has attempts left
 * goes back to `pending` for the next tick; the failure that exhausts the cap
 * lands on `failed` with a visible `last_error`.
 */
export async function runReceiptWorkerTick(
  options: ReceiptWorkerOptions = {},
): Promise<ReceiptWorkerOutcome> {
  const config = getConfig();
  const engine = options.engine ?? engineForConfig(config);
  if (!engine) return { outcome: 'disabled' };

  const database = options.database ?? getRawDatabase();
  const storageDir = options.storageDir ?? config.receiptStorageDir;
  const maxAttempts = options.maxAttempts ?? MAX_RECEIPT_ATTEMPTS;

  const claimed = claimNextPendingReceipt(database);
  if (!claimed) return { outcome: 'idle' };

  // Only the attempt itself is guarded: a failure writing the outcome is a bug
  // here, not an OCR failure, and should surface rather than be recorded.
  let raw: string;
  try {
    const { imagePath } = claimed;
    if (!imagePath) {
      throw new AppError(
        500,
        'IMAGE_MISSING',
        'The receipt image is unavailable.',
      );
    }
    const imageBytes = readReceiptImage(storageDir, imagePath);
    raw = (await engine.extract({ imagePath, imageBytes })).raw;
  } catch (error) {
    const message = describeOcrFailure(error);
    const exhausted = claimed.attempts >= maxAttempts;
    finishClaim(database, claimed.id, {
      status: exhausted ? 'failed' : 'pending',
      lastError: message,
    });
    return exhausted
      ? {
          outcome: 'failed',
          receiptId: claimed.id,
          attempts: claimed.attempts,
          error: message,
        }
      : {
          outcome: 'retry-scheduled',
          receiptId: claimed.id,
          attempts: claimed.attempts,
          error: message,
        };
  }

  finishClaim(database, claimed.id, { status: 'review', ocrJson: raw });
  return { outcome: 'processed', receiptId: claimed.id };
}

/**
 * Manual retry: `failed` → `pending` only, resetting `attempts` so the receipt
 * gets a full run of auto-retries again. This is the one transition the retry
 * action allows — anything else is a conflict, not a way to nudge other states.
 * The previous `last_error` stays readable until the next attempt replaces it.
 */
export function retryReceipt(
  receiptId: string,
  database: SqliteDatabase = getRawDatabase(),
): { id: string; status: 'pending' } {
  const listId = currentListId(database);

  return runWriteTransaction(database, () => {
    const row = database
      .prepare('SELECT id, status FROM receipts WHERE id = ? AND list_id = ?')
      .get(receiptId, listId) as
      { id: string; status: ReceiptStatus } | undefined;
    if (!row) throw notFound('Receipt not found.');
    if (row.status !== 'failed') {
      throw conflict(
        'INVALID_STATUS',
        `Only a failed receipt can be retried; this one is ${row.status}.`,
        { status: row.status },
      );
    }

    database
      .prepare(
        `UPDATE receipts
            SET status = 'pending', attempts = 0, updated_at = ?
          WHERE id = ? AND list_id = ? AND status = 'failed'`,
      )
      .run(timestampNow(), receiptId, listId);

    return { id: receiptId, status: 'pending' as const };
  });
}

type ClaimOutcome =
  | { status: 'review'; ocrJson: string }
  | { status: 'pending' | 'failed'; lastError: string };

/**
 * Write the terminal (or retryable) state of a claim. The `status = 'processing'`
 * guard keeps this from clobbering a row another writer already moved on.
 */
function finishClaim(
  database: SqliteDatabase,
  receiptId: string,
  outcome: ClaimOutcome,
): void {
  const succeeded = outcome.status === 'review';
  const now = timestampNow();
  database
    .prepare(
      `UPDATE receipts
          SET status = ?, ocr_json = COALESCE(?, ocr_json),
              processed_at = COALESCE(?, processed_at), last_error = ?,
              updated_at = ?
        WHERE id = ? AND status = 'processing'`,
    )
    .run(
      outcome.status,
      succeeded ? outcome.ocrJson : null,
      succeeded ? now : null,
      succeeded ? null : outcome.lastError,
      now,
      receiptId,
    );
}

function readReceiptImage(storageDir: string, imagePath: string): Uint8Array {
  try {
    return readFileSync(join(storageDir, imagePath));
  } catch {
    throw new AppError(
      500,
      'IMAGE_MISSING',
      'The receipt image is missing from storage.',
    );
  }
}

function describeOcrFailure(error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error)).trim();
  const message = raw || 'OCR processing failed.';
  return message.length > MAX_LAST_ERROR_LENGTH
    ? `${message.slice(0, MAX_LAST_ERROR_LENGTH - 1)}…`
    : message;
}
