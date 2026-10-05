import { randomUUID } from 'node:crypto';
import { normalizeName } from '../../shared/normalize';
import { DEFAULT_GROUP_COLOR } from '../../shared/schemas';
import type {
  CreateGroupInput,
  ReorderGroupsInput,
  RenameGroupInput,
} from '../../shared/schemas';
import { AppError, conflict, notFound } from '../errors';
import { getRawDatabase } from '../db/connection';
import {
  assertExpectedRevision,
  assertServerInstance,
  bumpSnapshotRevision,
  currentListId,
  currentSnapshotRevision,
  mapUniqueConstraint,
  runWriteTransaction,
  timestampNow,
  type SqliteDatabase,
} from './common';
import { getServerInstanceId } from '../instance';

type GroupRow = {
  id: string;
  name: string;
  normalized_name: string;
  kind: 'store' | 'category';
  color: string;
  position: number;
  revision: number;
  archived_at: string | null;
};

type GroupPositionRow = { id: string; position: number; revision: number };

const MAX_GROUPS = 100;

function findLiveGroup(
  database: SqliteDatabase,
  listId: string,
  groupId: string,
): GroupRow | undefined {
  return database
    .prepare(
      `SELECT id, name, normalized_name, kind, color, position, revision, archived_at
			 FROM groups
			 WHERE id = ? AND list_id = ? AND archived_at IS NULL`,
    )
    .get(groupId, listId) as GroupRow | undefined;
}

function liveGroupDuplicate(
  database: SqliteDatabase,
  listId: string,
  normalizedName: string,
  excludingId?: string,
): { id: string } | undefined {
  return database
    .prepare(
      `SELECT id FROM groups
			 WHERE list_id = ? AND normalized_name = ? AND archived_at IS NULL
			   AND (? IS NULL OR id <> ?)`,
    )
    .get(listId, normalizedName, excludingId ?? null, excludingId ?? null) as
    { id: string } | undefined;
}

export function createGroup(
  input: CreateGroupInput,
  database: SqliteDatabase = getRawDatabase(),
): {
  serverInstanceId: string;
  revision: number;
  group: {
    id: string;
    name: string;
    kind: 'store' | 'category';
    color: string;
    position: number;
    revision: number;
  };
} {
  assertServerInstance(input.serverInstanceId);
  try {
    return runWriteTransaction(database, () => {
      const listId = currentListId(database);
      const count = database
        .prepare(
          'SELECT COUNT(*) AS count FROM groups WHERE list_id = ? AND archived_at IS NULL',
        )
        .get(listId) as { count: number };
      if (count.count >= MAX_GROUPS) {
        throw new AppError(
          400,
          'GROUP_LIMIT',
          'The list has reached its group limit.',
        );
      }

      const normalizedName = normalizeName(input.name);
      const duplicate = liveGroupDuplicate(database, listId, normalizedName);
      if (duplicate) {
        throw conflict(
          'GROUP_NAME_EXISTS',
          'A group with this name already exists.',
          {
            groupId: duplicate.id,
          },
        );
      }

      const positionRow = database
        .prepare(
          'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM groups WHERE list_id = ? AND archived_at IS NULL',
        )
        .get(listId) as { position: number };
      const now = timestampNow();
      const group = {
        id: randomUUID(),
        name: input.name.trim(),
        kind: input.kind,
        color: input.color ?? DEFAULT_GROUP_COLOR,
        position: positionRow.position,
        revision: 1,
      };
      database
        .prepare(
          `INSERT INTO groups (id, list_id, name, normalized_name, kind, color, position)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          group.id,
          listId,
          group.name,
          normalizedName,
          group.kind,
          group.color,
          group.position,
        );

      return {
        serverInstanceId: getServerInstanceId(),
        revision: bumpSnapshotRevision(database, now),
        group,
      };
    });
  } catch (error) {
    mapUniqueConstraint(error, 'A group with this name already exists.');
  }
}

export function renameGroup(
  groupId: string,
  input: RenameGroupInput,
  database: SqliteDatabase = getRawDatabase(),
): {
  serverInstanceId: string;
  revision: number;
  group: {
    id: string;
    name: string;
    kind: 'store' | 'category';
    color: string;
    position: number;
    revision: number;
  };
} {
  assertServerInstance(input.serverInstanceId);
  try {
    return runWriteTransaction(database, () => {
      const listId = currentListId(database);
      const group = findLiveGroup(database, listId, groupId);
      if (!group) throw notFound('That group no longer exists.');
      assertExpectedRevision(
        'group',
        groupId,
        group.revision,
        input.expectedRevision,
      );

      const normalizedName = normalizeName(input.name);
      const duplicate = liveGroupDuplicate(
        database,
        listId,
        normalizedName,
        groupId,
      );
      if (duplicate) {
        throw conflict(
          'GROUP_NAME_EXISTS',
          'A group with this name already exists.',
          {
            groupId: duplicate.id,
          },
        );
      }

      const name = input.name.trim();
      const color = input.color ?? group.color;
      const now = timestampNow();
      database
        .prepare(
          `UPDATE groups
					 SET name = ?, normalized_name = ?, color = ?, revision = revision + 1, updated_at = ?
					 WHERE id = ? AND list_id = ?`,
        )
        .run(name, normalizedName, color, now, groupId, listId);

      return {
        serverInstanceId: getServerInstanceId(),
        revision: bumpSnapshotRevision(database, now),
        group: {
          id: group.id,
          name,
          kind: group.kind,
          color,
          position: group.position,
          revision: group.revision + 1,
        },
      };
    });
  } catch (error) {
    mapUniqueConstraint(error, 'A group with this name already exists.');
  }
}

export function archiveGroup(
  groupId: string,
  input: { serverInstanceId: string; expectedRevision: number },
  database: SqliteDatabase = getRawDatabase(),
): {
  serverInstanceId: string;
  revision: number;
  groupId: string;
  groupRevision: number;
} {
  assertServerInstance(input.serverInstanceId);
  return runWriteTransaction(database, () => {
    const listId = currentListId(database);
    const group = findLiveGroup(database, listId, groupId);
    if (!group) throw notFound('That group no longer exists.');
    assertExpectedRevision(
      'group',
      groupId,
      group.revision,
      input.expectedRevision,
    );

    const now = timestampNow();
    database
      .prepare(
        `UPDATE groups
				 SET archived_at = ?, revision = revision + 1, updated_at = ?
				 WHERE id = ? AND list_id = ?`,
      )
      .run(now, now, groupId, listId);

    return {
      serverInstanceId: getServerInstanceId(),
      revision: bumpSnapshotRevision(database, now),
      groupId,
      groupRevision: group.revision + 1,
    };
  });
}

export function reorderGroups(
  input: ReorderGroupsInput,
  database: SqliteDatabase = getRawDatabase(),
): { serverInstanceId: string; revision: number; changedGroupIds: string[] } {
  assertServerInstance(input.serverInstanceId);
  return runWriteTransaction(database, () => {
    const listId = currentListId(database);
    const currentGroups = database
      .prepare(
        `SELECT id, position, revision FROM groups
				 WHERE list_id = ? AND archived_at IS NULL
				 ORDER BY position, id`,
      )
      .all(listId) as GroupPositionRow[];
    if (
      currentGroups.length !== input.groups.length ||
      currentGroups.some(
        (group) => !input.groups.some((item) => item.id === group.id),
      )
    ) {
      throw conflict(
        'GROUP_SET_CHANGED',
        'The group list changed. Refresh before reordering.',
      );
    }
    if (
      input.groups.some((group, index) => group.position !== index) ||
      input.groups.length > MAX_GROUPS
    ) {
      throw new AppError(
        400,
        'INVALID_GROUP_ORDER',
        'Group positions must be a complete ordered list.',
      );
    }

    const currentById = new Map(
      currentGroups.map((group) => [group.id, group]),
    );
    const changed = input.groups.filter((group) => {
      const current = currentById.get(group.id)!;
      if (current.position !== group.position) {
        assertExpectedRevision(
          'group',
          group.id,
          current.revision,
          group.expectedRevision,
        );
        return true;
      }
      return false;
    });

    if (changed.length === 0) {
      return {
        serverInstanceId: getServerInstanceId(),
        revision: currentSnapshotRevision(database),
        changedGroupIds: [],
      };
    }

    const now = timestampNow();
    const update = database.prepare(
      `UPDATE groups SET position = ?, revision = revision + 1, updated_at = ?
			 WHERE id = ? AND list_id = ?`,
    );
    for (const group of changed)
      update.run(group.position, now, group.id, listId);

    return {
      serverInstanceId: getServerInstanceId(),
      revision: bumpSnapshotRevision(database, now),
      changedGroupIds: changed.map((group) => group.id),
    };
  });
}
