/**
 * The learned aliases, as the alias surface reads them (plan §7, "Learning
 * loop").
 *
 * Reading is what makes the lifecycle visible: the overview groups every alias
 * per item — soft-deleted rows included, because the audit trail is the point of
 * deleting softly — and reports the phrases two items claim, which is exactly
 * the evidence tier 1 refuses to resolve (`ADR 0003`). Deleting is the one
 * write, and it never moves a timestamp: a row's `deleted_at` is the moment it
 * was deleted, and a second delete is a no-op rather than a correction of that
 * record.
 *
 * Aliases stay out of the snapshot, so none of this bumps `app_state.revision`.
 */

import type {
  AliasOverview,
  ItemAlias,
  ItemAliases,
} from '../../shared/schemas';
import { getRawDatabase } from '../db/connection';
import { notFound } from '../errors';
import { ambiguousPhrases } from '../receipts/matcher';
import {
  currentListId,
  runWriteTransaction,
  timestampNow,
  type SqliteDatabase,
} from './common';
import { loadMatchContext } from './receipt-matching';

/** One stored alias with the item it belongs to, as the grouping reads it. */
type AliasRow = ItemAlias & { catalogItemId: string; name: string };

/**
 * Every alias of this list, grouped per item, live rows before deleted ones,
 * plus the phrases matching cannot resolve. Deleted aliases are always part of
 * the answer: they are queryable for audit, and the surface decides whether to
 * show them.
 */
export function listAliases(
  database: SqliteDatabase = getRawDatabase(),
): AliasOverview {
  const listId = currentListId(database);
  const rows = database
    .prepare(
      `SELECT a.id, a.catalog_item_id AS catalogItemId, i.display_name AS name,
              a.alias_text AS aliasText, a.normalized_alias AS normalizedAlias,
              a.source, a.created_at AS createdAt, a.deleted_at AS deletedAt
         FROM item_aliases a
         JOIN catalog_items i ON i.id = a.catalog_item_id
        WHERE a.list_id = ?
        ORDER BY i.normalized_name, i.id, a.deleted_at IS NOT NULL,
                 a.normalized_alias, a.id`,
    )
    .all(listId) as AliasRow[];

  return {
    items: groupByItem(rows),
    ambiguous: ambiguousPhrases(loadMatchContext(database, listId, null)),
  };
}

/**
 * Soft-delete one alias: it stops auto-binding immediately (every lookup skips
 * a deleted row) while the row itself survives as the audit trail. Relearning
 * revives it when the same reviewed text is confirmed again (`learnAlias` in
 * the receipts service), which is why there is no "restore" here — a revival is
 * a review, and the plan's correction path is delete + relearn.
 *
 * Idempotent, like a discard: a second delete has nothing left to do and leaves
 * `deleted_at` exactly where the first one put it.
 */
export function deleteAlias(
  aliasId: string,
  database: SqliteDatabase = getRawDatabase(),
): AliasOverview {
  const listId = currentListId(database);

  return runWriteTransaction(database, () => {
    const row = database
      .prepare(
        'SELECT id, deleted_at AS deletedAt FROM item_aliases WHERE id = ? AND list_id = ?',
      )
      .get(aliasId, listId) as
      { id: string; deletedAt: string | null } | undefined;
    if (!row) throw notFound('Alias not found.');

    if (!row.deletedAt) {
      const now = timestampNow();
      database
        .prepare(
          'UPDATE item_aliases SET deleted_at = ?, updated_at = ? WHERE id = ?',
        )
        .run(now, now, aliasId);
    }

    return listAliases(database);
  });
}

/** The flat rows as the per-item groups the surface renders. */
function groupByItem(rows: readonly AliasRow[]): ItemAliases[] {
  const items: ItemAliases[] = [];
  for (const row of rows) {
    const { catalogItemId, name, ...alias } = row;
    const current = items.at(-1);
    if (current?.catalogItemId === catalogItemId) current.aliases.push(alias);
    else items.push({ catalogItemId, name, aliases: [alias] });
  }
  return items;
}
