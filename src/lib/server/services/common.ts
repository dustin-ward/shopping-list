import { randomUUID } from 'node:crypto';
import { normalizeName } from '../../shared/normalize';
import { AppError, conflict } from '../errors';
import { getServerInstanceId } from '../instance';
import { openSqliteDatabase } from '../db/sqlite.js';

export type SqliteDatabase = ReturnType<typeof openSqliteDatabase>;

type ListStateRow = { list_id: string };
type CatalogItemRow = { id: string };
type GroupRow = {
  id: string;
  name: string;
  normalized_name: string;
  kind: 'store' | 'category';
};

export function assertServerInstance(requestInstanceId: string): void {
  const currentInstanceId = getServerInstanceId();
  if (requestInstanceId !== currentInstanceId) {
    throw conflict(
      'SERVER_CHANGED',
      'The server restarted. Refresh the list before saving.',
      {
        serverInstanceId: currentInstanceId,
      },
    );
  }
}

export function currentListId(database: SqliteDatabase): string {
  const state = database
    .prepare('SELECT list_id FROM app_state WHERE id = 1')
    .get() as ListStateRow | undefined;
  if (!state) {
    throw new AppError(
      500,
      'NOT_INITIALIZED',
      'The shared list has not been initialized.',
    );
  }
  return state.list_id;
}

export function runWriteTransaction<T>(
  database: SqliteDatabase,
  callback: () => T,
): T {
  return database.transaction(callback).immediate();
}

export function timestampNow(): string {
  return new Date().toISOString();
}

export function bumpSnapshotRevision(
  database: SqliteDatabase,
  now: string,
): number {
  database
    .prepare(
      'UPDATE app_state SET revision = revision + 1, updated_at = ? WHERE id = 1',
    )
    .run(now);
  const state = database
    .prepare('SELECT revision FROM app_state WHERE id = 1')
    .get() as { revision: number } | undefined;
  if (!state) {
    throw new AppError(
      500,
      'NOT_INITIALIZED',
      'The shared list has not been initialized.',
    );
  }
  return state.revision;
}

export function currentSnapshotRevision(database: SqliteDatabase): number {
  const state = database
    .prepare('SELECT revision FROM app_state WHERE id = 1')
    .get() as { revision: number } | undefined;
  if (!state) {
    throw new AppError(
      500,
      'NOT_INITIALIZED',
      'The shared list has not been initialized.',
    );
  }
  return state.revision;
}

export function assertExpectedRevision(
  resource: 'entry' | 'group',
  id: string,
  actualRevision: number,
  expectedRevision: number,
): void {
  if (actualRevision !== expectedRevision) {
    throw conflict(
      'REVISION_CONFLICT',
      `This ${resource} changed on another device. Refresh and review your changes.`,
      { id, expectedRevision, actualRevision },
    );
  }
}

export function validateLiveGroups(
  database: SqliteDatabase,
  listId: string,
  groupIds: string[],
): void {
  if (groupIds.length === 0) return;
  const placeholders = groupIds.map(() => '?').join(', ');
  const groups = database
    .prepare(
      `SELECT id FROM groups WHERE list_id = ? AND archived_at IS NULL AND id IN (${placeholders})`,
    )
    .all(listId, ...groupIds) as { id: string }[];
  if (groups.length !== groupIds.length) {
    throw new AppError(
      400,
      'INVALID_GROUP',
      'One or more selected groups are unavailable.',
      {
        fieldErrors: { groupIds: ['Choose current groups from this list.'] },
      },
    );
  }
}

export function getLiveGroup(
  database: SqliteDatabase,
  listId: string,
  groupId: string,
): GroupRow | undefined {
  return database
    .prepare(
      `SELECT id, name, normalized_name, kind
			 FROM groups
			 WHERE id = ? AND list_id = ? AND archived_at IS NULL`,
    )
    .get(groupId, listId) as GroupRow | undefined;
}

export function resolveCatalogItem(
  database: SqliteDatabase,
  listId: string,
  name: string,
  now: string,
): string {
  const normalizedName = normalizeName(name);
  const catalogItem = database
    .prepare(
      'SELECT id FROM catalog_items WHERE list_id = ? AND normalized_name = ?',
    )
    .get(listId, normalizedName) as CatalogItemRow | undefined;

  if (catalogItem) {
    database
      .prepare(
        'UPDATE catalog_items SET display_name = ?, updated_at = ? WHERE id = ?',
      )
      .run(name, now, catalogItem.id);
    return catalogItem.id;
  }

  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO catalog_items (id, list_id, display_name, normalized_name)
			 VALUES (?, ?, ?, ?)`,
    )
    .run(id, listId, name, normalizedName);
  return id;
}

export function replaceMemberships(
  database: SqliteDatabase,
  table: 'entry_groups' | 'catalog_item_groups',
  ownerColumn: 'entry_id' | 'catalog_item_id',
  ownerId: string,
  groupIds: string[],
): void {
  database
    .prepare(`DELETE FROM ${table} WHERE ${ownerColumn} = ?`)
    .run(ownerId);
  const insert = database.prepare(
    `INSERT INTO ${table} (${ownerColumn}, group_id) VALUES (?, ?)`,
  );
  for (const groupId of groupIds) insert.run(ownerId, groupId);
}

export function entryGroupIds(
  database: SqliteDatabase,
  entryId: string,
): string[] {
  return (
    database
      .prepare(
        `SELECT eg.group_id
				 FROM entry_groups eg
				 JOIN groups g ON g.id = eg.group_id
				 WHERE eg.entry_id = ? AND g.archived_at IS NULL
				 ORDER BY g.position, g.id`,
      )
      .all(entryId) as { group_id: string }[]
  ).map(({ group_id }) => group_id);
}

export function mapUniqueConstraint(error: unknown, message: string): never {
  if (
    error instanceof Error &&
    (error.message.includes('UNIQUE constraint failed') ||
      (error as Error & { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE')
  ) {
    throw conflict('DUPLICATE', message);
  }
  throw error;
}
