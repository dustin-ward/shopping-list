/**
 * The matcher's database half: what the list knows (items, human-confirmed
 * aliases, and which of them were confirmed at this store) and what the worker
 * writes back (the tier-1 bindings).
 *
 * The scoring itself stays pure in `receipts/matcher.ts`; this module is only
 * the evidence query and the one write, so the rules can be driven from
 * fixtures in tests without a database.
 */

import {
  matchReceiptLine,
  phraseForLine,
  type MatchContext,
  type MatcherAlias,
} from '../receipts/matcher';
import { timestampNow, type SqliteDatabase } from './common';

/**
 * Aliases a human confirmed — the only aliases tier 1 may bind on (plan §7).
 * Aliases are only ever addressed as `a`, so one fragment serves both queries.
 */
const HUMAN_CONFIRMED_ALIASES = `a.deleted_at IS NULL AND a.source IN ('manual', 'review')`;

type ItemRow = { catalogItemId: string; name: string; normalizedName: string };
type LineRow = { id: string; parsedName: string | null; rawText: string };

/**
 * The list's catalog items and confirmed aliases, with the same-store evidence
 * for one trip. `item_aliases` has no store column, so "confirmed at this
 * store" is the store of the committed line the alias was learned from
 * (`created_by_receipt_line_id`).
 */
export function loadMatchContext(
  database: SqliteDatabase,
  listId: string,
  storeGroupId: string | null,
): MatchContext {
  const items = database
    .prepare(
      `SELECT id AS catalogItemId, display_name AS name,
              normalized_name AS normalizedName
         FROM catalog_items
        WHERE list_id = ?
        ORDER BY normalized_name, id`,
    )
    .all(listId) as ItemRow[];

  const aliases = database
    .prepare(
      `SELECT a.catalog_item_id AS catalogItemId,
              a.alias_text AS aliasText,
              a.normalized_alias AS normalizedAlias
         FROM item_aliases a
        WHERE a.list_id = ? AND ${HUMAN_CONFIRMED_ALIASES}
        ORDER BY a.normalized_alias, a.catalog_item_id`,
    )
    .all(listId) as MatcherAlias[];

  const sameStore = storeGroupId
    ? sameStoreItemIds(database, listId, storeGroupId)
    : new Set<string>();

  return {
    items: items.map((item) => ({
      ...item,
      sameStore: sameStore.has(item.catalogItemId),
    })),
    aliases,
  };
}

/**
 * Bind every item line that has exactly one tier-1 candidate. Called from
 * `writeReceiptParse`, inside the same transaction that stores the lines, so a
 * receipt is never reviewable with its automatic bindings missing.
 */
export function bindTierOneMatches(
  database: SqliteDatabase,
  receiptId: string,
): void {
  const receipt = database
    .prepare(
      'SELECT list_id AS listId, store_group_id AS storeGroupId FROM receipts WHERE id = ?',
    )
    .get(receiptId) as
    { listId: string; storeGroupId: string | null } | undefined;
  if (!receipt) return;

  const lines = database
    .prepare(
      `SELECT id, parsed_name AS parsedName, raw_text AS rawText
         FROM receipt_lines
        WHERE receipt_id = ? AND is_item_chunk = 1
        ORDER BY line_index, id`,
    )
    .all(receiptId) as LineRow[];
  if (lines.length === 0) return;

  const context = loadMatchContext(
    database,
    receipt.listId,
    receipt.storeGroupId,
  );
  const bind = database.prepare(
    `UPDATE receipt_lines
        SET catalog_item_id = ?, review_state = 'bound', bound_via = 'auto',
            bound_rank = NULL, updated_at = ?
      WHERE id = ?`,
  );

  const now = timestampNow();
  for (const line of lines) {
    const match = matchReceiptLine(phraseForLine(line), context);
    if (match.bind) bind.run(match.bind, now, line.id);
  }
}

function sameStoreItemIds(
  database: SqliteDatabase,
  listId: string,
  storeGroupId: string,
): Set<string> {
  const rows = database
    .prepare(
      `SELECT DISTINCT a.catalog_item_id AS catalogItemId
         FROM item_aliases a
         JOIN receipt_lines l ON l.id = a.created_by_receipt_line_id
         JOIN receipts r ON r.id = l.receipt_id
        WHERE a.list_id = ? AND ${HUMAN_CONFIRMED_ALIASES}
          AND r.store_group_id = ?`,
    )
    .all(listId, storeGroupId) as { catalogItemId: string }[];
  return new Set(rows.map((row) => row.catalogItemId));
}
