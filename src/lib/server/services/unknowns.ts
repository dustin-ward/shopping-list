/**
 * The grouped unknown-line browser (ticket 17; plan §13 "R2 — matching
 * maturity": the unknown-line grouped browser, "grouped by normalized printed
 * text; doubles as the recategorization surface").
 *
 * Reading is the unidentified-spending view: every committed item line the
 * reviewer marked unknown, grouped by the wording the store printed. Writing is
 * a batch bind of one group: the item the reviewer picks becomes the binding of
 * every constituent line, in one transaction, and the wording becomes a learned
 * alias (source `review`) — the commit path's own rule — so the next receipt
 * that prints it binds without asking. A line with no printed wording can be
 * bound too, but teaches nothing: there is no phrase to match next time.
 *
 * The bind is deliberately idempotent at the row level: it updates only lines
 * that are still `unknown`, so a group another device has already repaired is
 * not re-bound from a stale view. Its answer says how many lines actually moved.
 */

import type {
  UnknownLinesBindInput,
  UnknownLinesBindResult,
  UnknownLinesOverview,
} from '../../shared/schemas';
import { normalizeName } from '../../shared/normalize';
import { getConfig } from '../config.js';
import { getRawDatabase } from '../db/connection';
import { notFound } from '../errors';
import {
  groupUnknownLines,
  unknownLinesOverview,
  type UnknownLineRow,
} from '../receipts/unknown-lines';
import {
  currentListId,
  runWriteTransaction,
  timestampNow,
  type SqliteDatabase,
} from './common';
import { learnAlias, requireLiveCatalogItem } from './receipts';

/** The unidentified-spending groups of this list, biggest spend first. */
export function listUnknownLines(
  database: SqliteDatabase = getRawDatabase(),
  currency: string = getConfig().receiptCurrency,
): UnknownLinesOverview {
  const listId = currentListId(database);
  return overviewOf(database, listId, currency);
}

/**
 * Bind every line of one grouped wording to an item. Only committed receipts
 * are the browser's scope, only item lines in `unknown` are its rows, and the
 * representative (most recent) printing is what the alias records.
 *
 * A phrase that already belongs to another item is not refused: conflicts are
 * kept (`ADR 0003`) and matching asks about them on the next receipt instead of
 * silently retargeting — which is exactly what the alias surface reports.
 */
export function bindUnknownLineGroup(
  input: UnknownLinesBindInput,
  database: SqliteDatabase = getRawDatabase(),
  currency: string = getConfig().receiptCurrency,
): UnknownLinesBindResult {
  const listId = currentListId(database);
  // The schema trims; normalization stays here too because the group key the
  // browser holds is normalized, and a defensive re-run can only make it match.
  const normalizedText = normalizeName(input.normalizedText);

  return runWriteTransaction(database, () => {
    requireLiveCatalogItem(database, listId, input.catalogItemId);

    const group = groupUnknownLines(loadUnknownLineRows(database, listId)).find(
      (candidate) => candidate.normalizedText === normalizedText,
    );
    if (!group) {
      throw notFound('No unknown lines carry that wording anymore.');
    }

    const now = timestampNow();
    const bind = database.prepare(
      `UPDATE receipt_lines
          SET review_state = 'bound', catalog_item_id = ?, bound_via = 'manual',
              bound_rank = NULL, updated_at = ?
        WHERE id = ? AND review_state = 'unknown'`,
    );
    let boundLineCount = 0;
    for (const lineId of group.lineIds) {
      boundLineCount += bind.run(input.catalogItemId, now, lineId).changes;
    }

    // A receipt's `updated_at` is the guard token of every write to it; the
    // binding moved, so it moves too.
    const touch = database.prepare(
      'UPDATE receipts SET updated_at = ? WHERE id = ? AND list_id = ?',
    );
    for (const receiptId of group.receiptIds) {
      touch.run(now, receiptId, listId);
    }

    // The empty phrasing has nothing to teach. Learning an empty alias would
    // claim every line whose text reads as blank, which is not a wording.
    if (boundLineCount > 0 && group.normalizedText) {
      learnAlias(
        database,
        listId,
        input.catalogItemId,
        {
          lineId: group.lineIds[0]!,
          aliasText: group.printedText,
          normalizedAlias: group.normalizedText,
        },
        now,
      );
    }

    return {
      overview: overviewOf(database, listId, currency),
      boundLineCount,
    };
  });
}

/** Read the groups and totals once, for both the read and the bind's answer. */
function overviewOf(
  database: SqliteDatabase,
  listId: string,
  currency: string,
): UnknownLinesOverview {
  return unknownLinesOverview(
    groupUnknownLines(loadUnknownLineRows(database, listId)),
    currency,
  );
}

/**
 * Every unknown item line of this list's committed receipts, newest commit
 * first. Parked rows are not bought things and `skipped` lines are a decision
 * of their own, so neither belongs in the unidentified-spending view.
 */
function loadUnknownLineRows(
  database: SqliteDatabase,
  listId: string,
): UnknownLineRow[] {
  return database
    .prepare(
      `SELECT l.id AS lineId, l.raw_text AS rawText,
              l.total_price_minor AS totalPriceMinor,
              l.quantity_real AS quantityReal,
              l.unit_price_minor AS unitPriceMinor,
              l.receipt_id AS receiptId, r.committed_at AS committedAt,
              l.line_index AS lineIndex
         FROM receipt_lines l
         JOIN receipts r ON r.id = l.receipt_id
        WHERE r.list_id = ? AND r.status = 'committed'
          AND l.is_item_chunk = 1 AND l.review_state = 'unknown'
        ORDER BY r.committed_at DESC, r.id DESC, l.line_index, l.id`,
    )
    .all(listId) as UnknownLineRow[];
}
