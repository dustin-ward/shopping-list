import { getRawDatabase } from '../db/connection';
import { AppError } from '../errors';
import { getServerInstanceId } from '../instance';
import type { Snapshot } from '../../shared/schemas';
import type { SqliteDatabase } from './common';

type SnapshotStateRow = {
  list_id: string;
  list_name: string;
  revision: number;
};

type GroupRow = {
  id: string;
  name: string;
  kind: 'store' | 'category';
  color: string;
  position: number;
  revision: number;
};

type CatalogRow = { id: string; name: string };
type MembershipRow = { owner_id: string; group_id: string };

type EntryRow = {
  id: string;
  catalog_item_id: string;
  name: string;
  quantity_text: string | null;
  note: string | null;
  status: 'active' | 'purchased';
  revision: number;
  created_at: string;
  completed_at: string | null;
  purchase_id: string | null;
  purchased_at: string | null;
  store_group_id: string | null;
  store_name_snapshot: string | null;
};

/** Read list metadata and every rendered list resource in one SQLite snapshot. */
export function getSnapshot(
  database: SqliteDatabase = getRawDatabase(),
): Snapshot {
  return database.transaction(() => {
    const state = database
      .prepare(
        `SELECT a.list_id, a.revision, l.name AS list_name
				 FROM app_state a
				 JOIN lists l ON l.id = a.list_id
				 WHERE a.id = 1`,
      )
      .get() as SnapshotStateRow | undefined;
    if (!state) {
      throw new AppError(
        500,
        'NOT_INITIALIZED',
        'The shared list has not been initialized.',
      );
    }

    const groups = database
      .prepare(
        `SELECT id, name, kind, color, position, revision
				 FROM groups
				 WHERE list_id = ? AND archived_at IS NULL
				 ORDER BY position, id`,
      )
      .all(state.list_id) as GroupRow[];

    const catalogItems = database
      .prepare(
        `SELECT id, display_name AS name
				 FROM catalog_items
				 WHERE list_id = ?
				 ORDER BY normalized_name, id`,
      )
      .all(state.list_id) as CatalogRow[];
    const defaultMemberships = database
      .prepare(
        `SELECT cig.catalog_item_id AS owner_id, cig.group_id
				 FROM catalog_item_groups cig
				 JOIN groups g ON g.id = cig.group_id
				 WHERE g.list_id = ? AND g.archived_at IS NULL
				 ORDER BY g.position, g.id`,
      )
      .all(state.list_id) as MembershipRow[];
    const defaultGroupsByItem = new Map<string, string[]>();
    for (const membership of defaultMemberships) {
      const groupIds = defaultGroupsByItem.get(membership.owner_id) ?? [];
      groupIds.push(membership.group_id);
      defaultGroupsByItem.set(membership.owner_id, groupIds);
    }

    const entries = database
      .prepare(
        `SELECT e.id, e.catalog_item_id, e.name, e.quantity_text, e.note, e.status,
				        e.revision, e.created_at, e.completed_at,
				        p.id AS purchase_id, p.purchased_at, p.store_group_id, p.store_name_snapshot
				 FROM list_entries e
				 LEFT JOIN purchases p ON p.entry_id = e.id AND p.voided_at IS NULL
				 WHERE e.list_id = ? AND e.archived_at IS NULL
				   AND e.status IN ('active', 'purchased')
				 ORDER BY CASE WHEN e.status = 'active' THEN 0 ELSE 1 END,
				          CASE WHEN e.status = 'active' THEN e.created_at END ASC,
				          CASE WHEN e.status = 'purchased' THEN e.completed_at END DESC,
				          e.id`,
      )
      .all(state.list_id) as EntryRow[];
    const entryMemberships = database
      .prepare(
        `SELECT eg.entry_id AS owner_id, eg.group_id
				 FROM entry_groups eg
				 JOIN list_entries e ON e.id = eg.entry_id
				 JOIN groups g ON g.id = eg.group_id
				 WHERE e.list_id = ? AND e.archived_at IS NULL AND g.archived_at IS NULL
				 ORDER BY g.position, g.id`,
      )
      .all(state.list_id) as MembershipRow[];
    const groupsByEntry = new Map<string, string[]>();
    for (const membership of entryMemberships) {
      const groupIds = groupsByEntry.get(membership.owner_id) ?? [];
      groupIds.push(membership.group_id);
      groupsByEntry.set(membership.owner_id, groupIds);
    }

    return {
      schemaVersion: 1 as const,
      list: { id: state.list_id, name: state.list_name },
      revision: state.revision,
      serverInstanceId: getServerInstanceId(),
      groups,
      catalogItems: catalogItems.map((item) => ({
        id: item.id,
        name: item.name,
        defaultGroupIds: defaultGroupsByItem.get(item.id) ?? [],
      })),
      entries: entries.map((entry) => ({
        id: entry.id,
        catalogItemId: entry.catalog_item_id,
        name: entry.name,
        quantityText: entry.quantity_text,
        note: entry.note,
        status: entry.status,
        revision: entry.revision,
        createdAt: entry.created_at,
        completedAt: entry.completed_at,
        groupIds: groupsByEntry.get(entry.id) ?? [],
        purchase: entry.purchase_id
          ? {
              id: entry.purchase_id,
              purchasedAt: entry.purchased_at!,
              storeGroupId: entry.store_group_id,
              storeNameSnapshot: entry.store_name_snapshot,
            }
          : null,
      })),
    };
  })();
}
