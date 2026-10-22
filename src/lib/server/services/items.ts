/**
 * Canonical-item administration (ticket 19; plan §5 "Merge semantics (later)":
 * rename the household term, merge two items and re-point their history).
 *
 * A canonical item is the identity list entries, receipt lines, purchases and
 * aliases attach to, so both writes are deliberately conservative:
 *
 * - **Rename** moves the household term and the visible list entries carrying
 *   it. Printed variants (`receipt_lines.raw_text`, `parsed_name`), aliases and
 *   purchase snapshots are untouched — the receipt path never rewrites
 *   `display_name`, and `display_name` never rewrites a receipt (`ADR 0003`).
 * - **Merge** is one transaction that re-points every reference, moves the
 *   aliases, unions category memberships, and removes the absorbed item. It
 *   refuses when both items have an active list entry (the one-active-entry
 *   rule), and it counts every reference before and after; a merge whose counts
 *   do not reconcile throws, so SQLite rolls the whole thing back rather than
 *   leaving history on a row that no longer exists.
 */

import { randomUUID } from 'node:crypto';
import { normalizeName } from '../../shared/normalize';
import type {
  ItemOverview,
  ItemReferenceCounts,
  MergeItemsInput,
  MergeItemsResult,
  RenameItemInput,
  RenameItemResult,
} from '../../shared/schemas';
import { getRawDatabase } from '../db/connection';
import { AppError, badRequest, conflict, notFound } from '../errors';
import { getServerInstanceId } from '../instance';
import {
  mergeCountProblems,
  planAliasTransfer,
  type AliasRow,
} from '../items/merge-plan';
import {
  assertServerInstance,
  bumpSnapshotRevision,
  currentListId,
  currentSnapshotRevision,
  runWriteTransaction,
  timestampNow,
  type SqliteDatabase,
} from './common';

type ItemRow = { id: string; name: string; normalizedName: string };

type ActiveEntryRow = { id: string; catalogItemId: string };

/** Every canonical item of this list, alphabetical, with its reference counts. */
export function listItems(
  database: SqliteDatabase = getRawDatabase(),
): ItemOverview {
  return database.transaction(() => {
    const listId = currentListId(database);
    const rows = database
      .prepare(
        `SELECT id, display_name AS name
           FROM catalog_items
          WHERE list_id = ?
          ORDER BY normalized_name, id`,
      )
      .all(listId) as { id: string; name: string }[];
    const counts = readReferenceCounts(
      database,
      listId,
      rows.map((row) => row.id),
    );

    return {
      items: rows.map((row) => ({
        ...row,
        counts: counts.get(row.id)!,
      })),
    };
  })();
}

/**
 * Rename the household term. Visible list entries adopt the new name (their
 * `name` is a copy of the term and the list renders it), and their revisions
 * move so an edit made from a stale screen refuses instead of recreating the old
 * item by name. Historical rows — cancelled or archived entries — keep the copy
 * they were recorded with.
 */
export function renameItem(
  itemId: string,
  input: RenameItemInput,
  database: SqliteDatabase = getRawDatabase(),
): RenameItemResult {
  return runWriteTransaction(database, () => {
    assertServerInstance(input.serverInstanceId);
    const listId = currentListId(database);
    const item = findItem(database, listId, itemId);
    if (!item) throw notFound('That item no longer exists.');
    assertItemName(item, input.expectedName);
    const name = input.name.trim();

    if (name === item.name) {
      return {
        serverInstanceId: getServerInstanceId(),
        revision: currentSnapshotRevision(database),
        item: { id: itemId, name },
        renamedEntryCount: 0,
      };
    }

    const collision = database
      .prepare(
        `SELECT id, display_name AS name
           FROM catalog_items
          WHERE list_id = ? AND normalized_name = ? AND id <> ?`,
      )
      .get(listId, normalizeName(name), itemId) as
      { id: string; name: string } | undefined;
    if (collision) {
      throw conflict(
        'ITEM_NAME_EXISTS',
        `"${collision.name}" already uses this name. Merge the items instead, or choose another name.`,
        { itemId: collision.id, name: collision.name },
      );
    }

    const now = timestampNow();
    database
      .prepare(
        `UPDATE catalog_items
            SET display_name = ?, normalized_name = ?, updated_at = ?
          WHERE id = ? AND list_id = ?`,
      )
      .run(name, normalizeName(name), now, itemId, listId);
    const renamedEntries = database
      .prepare(
        `UPDATE list_entries
            SET name = ?, revision = revision + 1, updated_at = ?
          WHERE list_id = ? AND catalog_item_id = ?
            AND archived_at IS NULL AND status IN ('active', 'purchased')`,
      )
      .run(name, now, listId, itemId);

    return {
      serverInstanceId: getServerInstanceId(),
      revision: bumpSnapshotRevision(database, now),
      item: { id: itemId, name },
      renamedEntryCount: renamedEntries.changes,
    };
  });
}

/**
 * Merge the absorbed item into the survivor: re-point receipt lines, purchases
 * and list entries, move aliases (retiring live duplicates, teaching the
 * absorbed term), union category memberships, and delete the absorbed row.
 */
export function mergeItems(
  absorbedId: string,
  input: MergeItemsInput,
  database: SqliteDatabase = getRawDatabase(),
): MergeItemsResult {
  return runWriteTransaction(database, () => {
    assertServerInstance(input.serverInstanceId);
    const listId = currentListId(database);
    if (input.survivorId === absorbedId) {
      throw badRequest(
        'INVALID_MERGE',
        'Choose a different item to merge into.',
      );
    }

    const absorbed = findItem(database, listId, absorbedId);
    if (!absorbed) throw notFound('That item no longer exists.');
    const survivor = findItem(database, listId, input.survivorId);
    if (!survivor) throw notFound('The item to merge into no longer exists.');
    assertItemName(absorbed, input.expectedName);
    assertItemName(survivor, input.expectedSurvivorName);

    // The one-active-entry-per-item index is the schema's rule, not ours: two
    // active entries cannot both survive on one item, so the merge asks the
    // household to resolve the conflict rather than silently cancelling one.
    const activeEntries = database
      .prepare(
        `SELECT id, catalog_item_id AS catalogItemId
           FROM list_entries
          WHERE list_id = ? AND catalog_item_id IN (?, ?)
            AND status = 'active' AND archived_at IS NULL
          ORDER BY created_at, id`,
      )
      .all(listId, absorbedId, survivor.id) as ActiveEntryRow[];
    const absorbedActive = activeEntries.find(
      (entry) => entry.catalogItemId === absorbedId,
    );
    const survivorActive = activeEntries.find(
      (entry) => entry.catalogItemId === survivor.id,
    );
    if (absorbedActive && survivorActive) {
      throw conflict(
        'MERGE_ACTIVE_ENTRY_CONFLICT',
        `Both "${absorbed.name}" and "${survivor.name}" are on the list. Remove one from the list, then merge.`,
        {
          absorbedEntryId: absorbedActive.id,
          survivorEntryId: survivorActive.id,
        },
      );
    }

    const before = countPair(database, listId, survivor.id, absorbed.id);
    const aliases = readAliases(database, listId, [survivor.id, absorbed.id]);
    const transfer = planAliasTransfer(
      aliases.get(survivor.id) ?? [],
      aliases.get(absorbed.id) ?? [],
      absorbed.name,
    );

    const now = timestampNow();
    const retire = database.prepare(
      `UPDATE item_aliases
          SET deleted_at = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL`,
    );
    for (const aliasId of transfer.retireIds) retire.run(now, now, aliasId);

    const move = database.prepare(
      'UPDATE item_aliases SET catalog_item_id = ?, updated_at = ? WHERE id = ?',
    );
    for (const aliasId of transfer.moveIds) {
      move.run(survivor.id, now, aliasId);
    }

    if (transfer.learned.kind === 'create') {
      database
        .prepare(
          `INSERT INTO item_aliases
             (id, list_id, catalog_item_id, alias_text, normalized_alias, source,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)`,
        )
        .run(
          randomUUID(),
          listId,
          survivor.id,
          transfer.learned.aliasText,
          transfer.learned.normalizedAlias,
          now,
          now,
        );
    } else if (transfer.learned.kind === 'revive') {
      database
        .prepare(
          `UPDATE item_aliases
              SET deleted_at = NULL, source = 'manual', updated_at = ?
            WHERE id = ?`,
        )
        .run(now, transfer.learned.id);
    }

    database
      .prepare(
        'UPDATE receipt_lines SET catalog_item_id = ?, updated_at = ? WHERE catalog_item_id = ?',
      )
      .run(survivor.id, now, absorbed.id);
    database
      .prepare(
        'UPDATE purchases SET catalog_item_id = ? WHERE catalog_item_id = ?',
      )
      .run(survivor.id, absorbed.id);

    // Entries move; the visible ones also adopt the surviving household term so
    // the list keeps reading consistently, and their revisions move so a stale
    // edit cannot resurrect the absorbed name as a new item.
    database
      .prepare(
        `UPDATE list_entries
            SET catalog_item_id = ?,
                name = CASE WHEN archived_at IS NULL AND status IN ('active', 'purchased')
                            THEN ? ELSE name END,
                revision = CASE WHEN archived_at IS NULL AND status IN ('active', 'purchased')
                                THEN revision + 1 ELSE revision END,
                updated_at = CASE WHEN archived_at IS NULL AND status IN ('active', 'purchased')
                                  THEN ? ELSE updated_at END
          WHERE list_id = ? AND catalog_item_id = ?`,
      )
      .run(survivor.id, survivor.name, now, listId, absorbed.id);

    // Category memberships are a set: keep the survivor's, add what the absorbed
    // item had, and drop the rows that were duplicates of the survivor's.
    database
      .prepare(
        'UPDATE OR IGNORE catalog_item_groups SET catalog_item_id = ? WHERE catalog_item_id = ?',
      )
      .run(survivor.id, absorbed.id);
    const membershipsLeft = database
      .prepare(
        'SELECT COUNT(*) AS value FROM catalog_item_groups WHERE catalog_item_id = ?',
      )
      .get(absorbed.id) as { value: number };
    database
      .prepare('DELETE FROM catalog_item_groups WHERE catalog_item_id = ?')
      .run(absorbed.id);
    const membershipsDropped = membershipsLeft.value;

    database
      .prepare('DELETE FROM catalog_items WHERE id = ? AND list_id = ?')
      .run(absorbed.id, listId);

    const after = countPair(database, listId, survivor.id, absorbed.id);
    const aliasesLearned = transfer.learned.kind === 'create' ? 1 : 0;
    const aliasesRevived = transfer.learned.kind === 'revive' ? 1 : 0;
    const problems = mergeCountProblems({
      before,
      after,
      aliasesRetired: transfer.retireIds.length,
      aliasesLearned,
      aliasesRevived,
      membershipsDropped,
    });
    if (problems.length > 0) {
      throw new AppError(
        500,
        'MERGE_COUNT_MISMATCH',
        'The merge could not prove that every reference moved, so nothing was changed.',
        { details: { problems } },
      );
    }

    return {
      serverInstanceId: getServerInstanceId(),
      revision: bumpSnapshotRevision(database, now),
      survivor: { id: survivor.id, name: survivor.name },
      absorbed: { id: absorbed.id, name: absorbed.name },
      before,
      after,
      aliasesMoved: transfer.moveIds.length,
      aliasesRetired: transfer.retireIds.length,
      aliasesLearned,
      aliasesRevived,
      membershipsDropped,
    };
  });
}

function findItem(
  database: SqliteDatabase,
  listId: string,
  itemId: string,
): ItemRow | undefined {
  return database
    .prepare(
      `SELECT id, display_name AS name, normalized_name AS normalizedName
         FROM catalog_items
        WHERE id = ? AND list_id = ?`,
    )
    .get(itemId, listId) as ItemRow | undefined;
}

/** The stale-view guard: the caller names the term it last saw. */
function assertItemName(item: ItemRow, expectedName: string): void {
  if (item.name === expectedName) return;
  throw conflict(
    'ITEM_CHANGED',
    'This item changed on another device. Refresh and try again.',
    { itemId: item.id, currentName: item.name },
  );
}

function countPair(
  database: SqliteDatabase,
  listId: string,
  survivorId: string,
  absorbedId: string,
): MergeItemsResult['before'] {
  const counts = readReferenceCounts(database, listId, [
    survivorId,
    absorbedId,
  ]);
  return {
    survivor: counts.get(survivorId)!,
    absorbed: counts.get(absorbedId)!,
  };
}

function readAliases(
  database: SqliteDatabase,
  listId: string,
  itemIds: readonly string[],
): Map<string, AliasRow[]> {
  const byItem = new Map<string, AliasRow[]>();
  for (const itemId of itemIds) byItem.set(itemId, []);
  if (itemIds.length === 0) return byItem;

  const placeholders = itemIds.map(() => '?').join(', ');
  const rows = database
    .prepare(
      `SELECT id, catalog_item_id AS catalogItemId, alias_text AS aliasText,
              normalized_alias AS normalizedAlias, deleted_at AS deletedAt
         FROM item_aliases
        WHERE list_id = ? AND catalog_item_id IN (${placeholders})
        ORDER BY catalog_item_id, deleted_at IS NOT NULL, normalized_alias, id`,
    )
    .all(listId, ...itemIds) as (AliasRow & { catalogItemId: string })[];

  for (const { catalogItemId, ...alias } of rows) {
    byItem.get(catalogItemId)?.push(alias);
  }
  return byItem;
}

/**
 * Every row that references one of these items, in one place. The merge reads
 * this before and after its transaction; the management list reads it for every
 * item, so the count a reviewer sees before merging is the same count the audit
 * proves afterward.
 */
function readReferenceCounts(
  database: SqliteDatabase,
  listId: string,
  itemIds: readonly string[],
): Map<string, ItemReferenceCounts> {
  const counts = new Map<string, ItemReferenceCounts>(
    itemIds.map((itemId) => [itemId, emptyCounts()]),
  );
  if (itemIds.length === 0) return counts;

  const placeholders = itemIds.map(() => '?').join(', ');
  const read = (
    field: keyof ItemReferenceCounts,
    sql: string,
    parameters: readonly unknown[] = [listId, ...itemIds],
  ) => {
    const rows = database.prepare(sql).all(...parameters) as {
      id: string;
      value: number;
    }[];
    for (const row of rows) {
      const item = counts.get(row.id);
      if (item) item[field] = row.value;
    }
  };

  read(
    'receiptLines',
    `SELECT l.catalog_item_id AS id, COUNT(*) AS value
       FROM receipt_lines l
       JOIN receipts r ON r.id = l.receipt_id
      WHERE r.list_id = ? AND l.catalog_item_id IN (${placeholders})
      GROUP BY l.catalog_item_id`,
  );
  read(
    'committedReceiptLines',
    `SELECT l.catalog_item_id AS id, COUNT(*) AS value
       FROM receipt_lines l
       JOIN receipts r ON r.id = l.receipt_id
      WHERE r.list_id = ? AND r.status = 'committed'
        AND l.catalog_item_id IN (${placeholders})
      GROUP BY l.catalog_item_id`,
  );
  read(
    'purchases',
    `SELECT p.catalog_item_id AS id, COUNT(*) AS value
       FROM purchases p
       JOIN list_entries e ON e.id = p.entry_id
      WHERE e.list_id = ? AND p.catalog_item_id IN (${placeholders})
      GROUP BY p.catalog_item_id`,
  );
  read(
    'liveAliases',
    `SELECT catalog_item_id AS id, COUNT(*) AS value
       FROM item_aliases
      WHERE list_id = ? AND deleted_at IS NULL
        AND catalog_item_id IN (${placeholders})
      GROUP BY catalog_item_id`,
  );
  read(
    'deletedAliases',
    `SELECT catalog_item_id AS id, COUNT(*) AS value
       FROM item_aliases
      WHERE list_id = ? AND deleted_at IS NOT NULL
        AND catalog_item_id IN (${placeholders})
      GROUP BY catalog_item_id`,
  );
  read(
    'listEntries',
    `SELECT catalog_item_id AS id, COUNT(*) AS value
       FROM list_entries
      WHERE list_id = ? AND catalog_item_id IN (${placeholders})
      GROUP BY catalog_item_id`,
  );
  read(
    'activeListEntries',
    `SELECT catalog_item_id AS id, COUNT(*) AS value
       FROM list_entries
      WHERE list_id = ? AND catalog_item_id IN (${placeholders})
        AND status = 'active' AND archived_at IS NULL
      GROUP BY catalog_item_id`,
  );
  read(
    'categoryMemberships',
    `SELECT cig.catalog_item_id AS id, COUNT(*) AS value
       FROM catalog_item_groups cig
       JOIN catalog_items i ON i.id = cig.catalog_item_id
      WHERE i.list_id = ? AND cig.catalog_item_id IN (${placeholders})
      GROUP BY cig.catalog_item_id`,
  );

  return counts;
}

function emptyCounts(): ItemReferenceCounts {
  return {
    receiptLines: 0,
    committedReceiptLines: 0,
    purchases: 0,
    liveAliases: 0,
    deletedAliases: 0,
    listEntries: 0,
    activeListEntries: 0,
    categoryMemberships: 0,
  };
}
