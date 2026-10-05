import { randomUUID } from 'node:crypto';
import type {
  AddEntryInput,
  ArchiveEntriesInput,
  EditEntryInput,
  EntryRevisionInput,
  PurchaseEntryInput,
} from '../../shared/schemas';
import { AppError, conflict, notFound } from '../errors';
import { getRawDatabase } from '../db/connection';
import {
  assertExpectedRevision,
  assertServerInstance,
  bumpSnapshotRevision,
  currentListId,
  getLiveGroup,
  mapUniqueConstraint,
  replaceMemberships,
  resolveCatalogItem,
  runWriteTransaction,
  timestampNow,
  validateLiveGroups,
  type SqliteDatabase,
} from './common';
import { getServerInstanceId } from '../instance';

type EntryRow = {
  id: string;
  list_id: string;
  catalog_item_id: string;
  name: string;
  quantity_text: string | null;
  note: string | null;
  status: 'active' | 'purchased' | 'cancelled';
  revision: number;
  completed_at: string | null;
  archived_at: string | null;
};

type ExistingIdRow = { id: string };

function cleanOptionalText(value: string | null | undefined): string | null {
  const cleaned = value?.trim() ?? '';
  return cleaned.length > 0 ? cleaned : null;
}

function findEntry(
  database: SqliteDatabase,
  listId: string,
  entryId: string,
): EntryRow | undefined {
  return database
    .prepare(
      `SELECT id, list_id, catalog_item_id, name, quantity_text, note, status,
			        revision, completed_at, archived_at
			 FROM list_entries
			 WHERE id = ? AND list_id = ?`,
    )
    .get(entryId, listId) as EntryRow | undefined;
}

function requireActiveEntry(
  entry: EntryRow | undefined,
): asserts entry is EntryRow {
  if (!entry) throw notFound('That list item no longer exists.');
  if (entry.status !== 'active' || entry.archived_at !== null) {
    throw conflict(
      'ENTRY_NOT_ACTIVE',
      'Only active items can be edited or removed.',
      {
        entryId: entry.id,
      },
    );
  }
}

export function addEntry(
  input: AddEntryInput,
  database: SqliteDatabase = getRawDatabase(),
): {
  serverInstanceId: string;
  revision: number;
  entryId: string;
  entryRevision: number;
} {
  assertServerInstance(input.serverInstanceId);
  try {
    return runWriteTransaction(database, () => {
      const listId = currentListId(database);
      const existingId = database
        .prepare('SELECT id FROM list_entries WHERE id = ?')
        .get(input.id) as ExistingIdRow | undefined;
      if (existingId) {
        throw conflict(
          'ENTRY_ID_EXISTS',
          'This item may already have been added. Refresh the list before trying again.',
          { entryId: existingId.id },
        );
      }

      validateLiveGroups(database, listId, input.groupIds);
      const now = timestampNow();
      const name = input.name.trim();
      const catalogItemId = resolveCatalogItem(database, listId, name, now);
      const activeEntry = database
        .prepare(
          `SELECT id FROM list_entries
					 WHERE list_id = ? AND catalog_item_id = ? AND status = 'active'
					   AND archived_at IS NULL`,
        )
        .get(listId, catalogItemId) as ExistingIdRow | undefined;
      if (activeEntry) {
        throw conflict('ALREADY_ON_LIST', 'Already on the list.', {
          entryId: activeEntry.id,
        });
      }

      database
        .prepare(
          `INSERT INTO list_entries
					 (id, list_id, catalog_item_id, name, quantity_text, note, status, revision,
					  created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
        )
        .run(
          input.id,
          listId,
          catalogItemId,
          name,
          cleanOptionalText(input.quantityText),
          cleanOptionalText(input.note),
          now,
          now,
        );
      replaceMemberships(
        database,
        'entry_groups',
        'entry_id',
        input.id,
        input.groupIds,
      );
      replaceMemberships(
        database,
        'catalog_item_groups',
        'catalog_item_id',
        catalogItemId,
        input.groupIds,
      );

      return {
        serverInstanceId: getServerInstanceId(),
        revision: bumpSnapshotRevision(database, now),
        entryId: input.id,
        entryRevision: 1,
      };
    });
  } catch (error) {
    mapUniqueConstraint(
      error,
      'An item with this name is already on the list.',
    );
  }
}

export function editEntry(
  entryId: string,
  input: EditEntryInput,
  database: SqliteDatabase = getRawDatabase(),
): {
  serverInstanceId: string;
  revision: number;
  entryId: string;
  entryRevision: number;
} {
  assertServerInstance(input.serverInstanceId);
  try {
    return runWriteTransaction(database, () => {
      const listId = currentListId(database);
      const entry = findEntry(database, listId, entryId);
      requireActiveEntry(entry);
      assertExpectedRevision(
        'entry',
        entryId,
        entry.revision,
        input.expectedRevision,
      );
      validateLiveGroups(database, listId, input.groupIds);

      const now = timestampNow();
      const name = input.name.trim();
      const catalogItemId = resolveCatalogItem(database, listId, name, now);
      const duplicate = database
        .prepare(
          `SELECT id FROM list_entries
					 WHERE list_id = ? AND catalog_item_id = ? AND status = 'active'
					   AND archived_at IS NULL AND id <> ?`,
        )
        .get(listId, catalogItemId, entryId) as ExistingIdRow | undefined;
      if (duplicate) {
        throw conflict(
          'ALREADY_ON_LIST',
          'Another active item already uses this name.',
          {
            entryId: duplicate.id,
          },
        );
      }

      database
        .prepare(
          `UPDATE list_entries
					 SET catalog_item_id = ?, name = ?, quantity_text = ?, note = ?,
					     revision = revision + 1, updated_at = ?
					 WHERE id = ? AND list_id = ?`,
        )
        .run(
          catalogItemId,
          name,
          cleanOptionalText(input.quantityText),
          cleanOptionalText(input.note),
          now,
          entryId,
          listId,
        );
      replaceMemberships(
        database,
        'entry_groups',
        'entry_id',
        entryId,
        input.groupIds,
      );
      replaceMemberships(
        database,
        'catalog_item_groups',
        'catalog_item_id',
        catalogItemId,
        input.groupIds,
      );

      return {
        serverInstanceId: getServerInstanceId(),
        revision: bumpSnapshotRevision(database, now),
        entryId,
        entryRevision: entry.revision + 1,
      };
    });
  } catch (error) {
    mapUniqueConstraint(error, 'Another active item already uses this name.');
  }
}

export function cancelEntry(
  entryId: string,
  input: EntryRevisionInput,
  database: SqliteDatabase = getRawDatabase(),
): {
  serverInstanceId: string;
  revision: number;
  entryId: string;
  entryRevision: number;
} {
  assertServerInstance(input.serverInstanceId);
  return runWriteTransaction(database, () => {
    const listId = currentListId(database);
    const entry = findEntry(database, listId, entryId);
    requireActiveEntry(entry);
    assertExpectedRevision(
      'entry',
      entryId,
      entry.revision,
      input.expectedRevision,
    );

    const now = timestampNow();
    database
      .prepare(
        `UPDATE list_entries
				 SET status = 'cancelled', archived_at = ?, revision = revision + 1, updated_at = ?
				 WHERE id = ? AND list_id = ?`,
      )
      .run(now, now, entryId, listId);

    return {
      serverInstanceId: getServerInstanceId(),
      revision: bumpSnapshotRevision(database, now),
      entryId,
      entryRevision: entry.revision + 1,
    };
  });
}

export function purchaseEntry(
  entryId: string,
  input: PurchaseEntryInput,
  database: SqliteDatabase = getRawDatabase(),
): {
  serverInstanceId: string;
  revision: number;
  entryId: string;
  entryRevision: number;
  purchaseId: string;
} {
  assertServerInstance(input.serverInstanceId);
  return runWriteTransaction(database, () => {
    const listId = currentListId(database);
    const entry = findEntry(database, listId, entryId);
    requireActiveEntry(entry);
    assertExpectedRevision(
      'entry',
      entryId,
      entry.revision,
      input.expectedRevision,
    );

    const storeGroupId = input.storeGroupId || null;
    const store = storeGroupId
      ? getLiveGroup(database, listId, storeGroupId)
      : undefined;
    if (storeGroupId && (!store || store.kind !== 'store')) {
      throw new AppError(
        400,
        'INVALID_STORE',
        'Choose a current store group or no store.',
      );
    }

    const now = timestampNow();
    const purchaseId = randomUUID();
    database
      .prepare(
        `UPDATE list_entries
				 SET status = 'purchased', completed_at = ?, revision = revision + 1, updated_at = ?
				 WHERE id = ? AND list_id = ?`,
      )
      .run(now, now, entryId, listId);
    database
      .prepare(
        `INSERT INTO purchases
				 (id, entry_id, catalog_item_id, name_snapshot, quantity_snapshot, note_snapshot,
				  purchased_at, store_group_id, store_name_snapshot)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        purchaseId,
        entryId,
        entry.catalog_item_id,
        entry.name,
        entry.quantity_text,
        entry.note,
        now,
        store?.id ?? null,
        store?.name ?? null,
      );

    return {
      serverInstanceId: getServerInstanceId(),
      revision: bumpSnapshotRevision(database, now),
      entryId,
      entryRevision: entry.revision + 1,
      purchaseId,
    };
  });
}

export function undoPurchase(
  entryId: string,
  input: EntryRevisionInput,
  database: SqliteDatabase = getRawDatabase(),
): {
  serverInstanceId: string;
  revision: number;
  entryId: string;
  entryRevision: number;
} {
  assertServerInstance(input.serverInstanceId);
  return runWriteTransaction(database, () => {
    const listId = currentListId(database);
    const entry = findEntry(database, listId, entryId);
    if (!entry) throw notFound('That purchased item no longer exists.');
    assertExpectedRevision(
      'entry',
      entryId,
      entry.revision,
      input.expectedRevision,
    );
    if (entry.status !== 'purchased' || entry.archived_at !== null) {
      throw conflict(
        'ENTRY_NOT_PURCHASED',
        'Only visible purchased items can be undone.',
        {
          entryId,
        },
      );
    }

    const purchase = database
      .prepare(
        `SELECT id FROM purchases
				 WHERE entry_id = ? AND voided_at IS NULL
				 ORDER BY purchased_at DESC, id DESC LIMIT 1`,
      )
      .get(entryId) as { id: string } | undefined;
    if (!purchase) {
      throw new AppError(
        500,
        'PURCHASE_MISSING',
        'The purchase record for this item is missing.',
      );
    }

    const activeDuplicate = database
      .prepare(
        `SELECT id FROM list_entries
				 WHERE list_id = ? AND catalog_item_id = ? AND status = 'active'
				   AND archived_at IS NULL AND id <> ?`,
      )
      .get(listId, entry.catalog_item_id, entryId) as ExistingIdRow | undefined;
    if (activeDuplicate) {
      throw conflict('ITEM_ALREADY_ACTIVE', 'This item is already active.', {
        entryId: activeDuplicate.id,
      });
    }

    const now = timestampNow();
    database
      .prepare(
        'UPDATE purchases SET voided_at = ? WHERE id = ? AND voided_at IS NULL',
      )
      .run(now, purchase.id);
    database
      .prepare(
        `UPDATE list_entries
				 SET status = 'active', completed_at = NULL, revision = revision + 1, updated_at = ?
				 WHERE id = ? AND list_id = ?`,
      )
      .run(now, entryId, listId);

    return {
      serverInstanceId: getServerInstanceId(),
      revision: bumpSnapshotRevision(database, now),
      entryId,
      entryRevision: entry.revision + 1,
    };
  });
}

export function archivePurchasedEntries(
  input: ArchiveEntriesInput,
  database: SqliteDatabase = getRawDatabase(),
): { serverInstanceId: string; revision: number; archivedEntryIds: string[] } {
  assertServerInstance(input.serverInstanceId);
  return runWriteTransaction(database, () => {
    const listId = currentListId(database);
    const targets = input.entries.map(({ id, expectedRevision }) => {
      const entry = findEntry(database, listId, id);
      if (!entry) throw notFound('A selected purchased item no longer exists.');
      assertExpectedRevision('entry', id, entry.revision, expectedRevision);
      if (entry.status !== 'purchased' || entry.archived_at !== null) {
        throw conflict(
          'ENTRY_NOT_PURCHASED',
          'A selected item is no longer available to clear.',
          {
            entryId: id,
          },
        );
      }
      return entry;
    });

    const now = timestampNow();
    const update = database.prepare(
      `UPDATE list_entries
			 SET archived_at = ?, revision = revision + 1, updated_at = ?
			 WHERE id = ? AND list_id = ?`,
    );
    for (const entry of targets) update.run(now, now, entry.id, listId);

    return {
      serverInstanceId: getServerInstanceId(),
      revision: bumpSnapshotRevision(database, now),
      archivedEntryIds: targets.map((entry) => entry.id),
    };
  });
}
