import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getServerInstanceId } from '../../src/lib/server/instance';
import { DEFAULT_GROUP_COLOR } from '../../src/lib/shared/schemas';
import { migrateAndBootstrap } from '../../src/lib/server/db/lifecycle.js';
import { openSqliteDatabase } from '../../src/lib/server/db/sqlite.js';
import {
  archivePurchasedEntries,
  addEntry,
  cancelEntry,
  editEntry,
  purchaseEntry,
  undoPurchase,
} from '../../src/lib/server/services/entries';
import {
  archiveGroup,
  createGroup,
  reorderGroups,
  renameGroup,
} from '../../src/lib/server/services/groups';
import { getPurchaseHistory } from '../../src/lib/server/services/purchases';
import { getSnapshot } from '../../src/lib/server/services/snapshot';

let directory = '';
let database: ReturnType<typeof openSqliteDatabase>;
const serverInstanceId = getServerInstanceId();

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'shopping-list-services-'));
  database = openSqliteDatabase(join(directory, 'shopping-list.sqlite'));
  migrateAndBootstrap(database, resolve(process.cwd(), 'migrations'));
});

afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

function add(name: string, groupIds: string[] = []) {
  return addEntry(
    {
      id: randomUUID(),
      serverInstanceId,
      name,
      quantityText: null,
      note: null,
      groupIds,
    },
    database,
  );
}

function store(name: string) {
  return createGroup({ serverInstanceId, name, kind: 'store' }, database).group;
}

function caughtError(callback: () => unknown): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the operation to fail.');
}

describe('entry and group services', () => {
  it('persists chosen group colors across creation, edits, and snapshots', () => {
    const created = createGroup(
      {
        serverInstanceId,
        name: 'Produce',
        kind: 'category',
        color: '#487ca8',
      },
      database,
    );
    expect(created.group.color).toBe('#487ca8');
    expect(
      getSnapshot(database).groups.find(
        (group) => group.id === created.group.id,
      )?.color,
    ).toBe('#487ca8');

    const edited = renameGroup(
      created.group.id,
      {
        serverInstanceId,
        expectedRevision: created.group.revision,
        name: 'Fresh produce',
        color: '#c57b44',
      },
      database,
    );
    expect(edited.group.color).toBe('#c57b44');
    expect(
      getSnapshot(database).groups.find(
        (group) => group.id === created.group.id,
      )?.color,
    ).toBe('#c57b44');

    expect(store('Default color').color).toBe(DEFAULT_GROUP_COLOR);
  });

  it('purchases, voids on undo, repurchases, and clears without losing history', () => {
    const aldi = store('Aldi');
    const costco = store('Costco');
    const created = add('Eggs', [aldi.id, costco.id]);
    let snapshot = getSnapshot(database);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0].groupIds).toEqual([aldi.id, costco.id]);

    const firstPurchase = purchaseEntry(
      created.entryId,
      {
        serverInstanceId,
        expectedRevision: created.entryRevision,
        storeGroupId: aldi.id,
      },
      database,
    );
    snapshot = getSnapshot(database);
    expect(snapshot.entries[0].status).toBe('purchased');
    expect(snapshot.entries[0].purchase?.storeNameSnapshot).toBe('Aldi');
    expect(getPurchaseHistory(null, database).items).toHaveLength(1);

    const undone = undoPurchase(
      created.entryId,
      { serverInstanceId, expectedRevision: firstPurchase.entryRevision },
      database,
    );
    expect(getSnapshot(database).entries[0].status).toBe('active');
    expect(getPurchaseHistory(null, database).items).toHaveLength(0);
    expect(
      database
        .prepare(
          'SELECT COUNT(*) AS count FROM purchases WHERE voided_at IS NOT NULL',
        )
        .get(),
    ).toEqual({ count: 1 });
    const staleRetry = caughtError(() =>
      purchaseEntry(
        created.entryId,
        {
          serverInstanceId,
          expectedRevision: created.entryRevision,
          storeGroupId: aldi.id,
        },
        database,
      ),
    );
    expect(staleRetry).toMatchObject({ code: 'REVISION_CONFLICT' });

    const secondPurchase = purchaseEntry(
      created.entryId,
      {
        serverInstanceId,
        expectedRevision: undone.entryRevision,
        storeGroupId: costco.id,
      },
      database,
    );
    const cleared = archivePurchasedEntries(
      {
        serverInstanceId,
        entries: [
          {
            id: created.entryId,
            expectedRevision: secondPurchase.entryRevision,
          },
        ],
      },
      database,
    );
    expect(cleared.archivedEntryIds).toEqual([created.entryId]);
    expect(getSnapshot(database).entries).toEqual([]);
    expect(getPurchaseHistory(null, database).items).toHaveLength(1);
    expect(getPurchaseHistory(null, database).items[0].storeName).toBe(
      'Costco',
    );
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM purchases').get(),
    ).toEqual({ count: 2 });
  });

  it('rejects duplicate active identities and stale writes without overwriting', () => {
    const first = add('Fresh eggs');
    const duplicateError = caughtError(() => add('  Fresh   Eggs  '));
    expect(duplicateError).toMatchObject({ code: 'ALREADY_ON_LIST' });

    const updated = editEntry(
      first.entryId,
      {
        serverInstanceId,
        expectedRevision: first.entryRevision,
        name: 'Oat milk',
        quantityText: '2 cartons',
        note: null,
        groupIds: [],
      },
      database,
    );
    const staleError = caughtError(() =>
      editEntry(
        first.entryId,
        {
          serverInstanceId,
          expectedRevision: first.entryRevision,
          name: 'Whole milk',
          quantityText: null,
          note: null,
          groupIds: [],
        },
        database,
      ),
    );
    expect(staleError).toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(getSnapshot(database).entries[0].name).toBe('Oat milk');

    const independent = add('Bread');
    const independentUpdate = editEntry(
      independent.entryId,
      {
        serverInstanceId,
        expectedRevision: independent.entryRevision,
        name: 'Bread',
        quantityText: null,
        note: 'Sourdough',
        groupIds: [],
      },
      database,
    );
    expect(independentUpdate.entryRevision).toBe(2);
    expect(updated.entryRevision).toBe(2);
  });

  it('refuses an undo that would duplicate a newer active item', () => {
    const oldEntry = add('Butter');
    const purchased = purchaseEntry(
      oldEntry.entryId,
      { serverInstanceId, expectedRevision: oldEntry.entryRevision },
      database,
    );
    const newerEntry = add('Butter');

    const error = caughtError(() =>
      undoPurchase(
        oldEntry.entryId,
        { serverInstanceId, expectedRevision: purchased.entryRevision },
        database,
      ),
    );
    expect(error).toMatchObject({ code: 'ITEM_ALREADY_ACTIVE' });
    expect(getSnapshot(database).entries.map((entry) => entry.status)).toEqual([
      'active',
      'purchased',
    ]);
    expect(getPurchaseHistory(null, database).items).toHaveLength(1);
    expect(newerEntry.entryRevision).toBe(1);
  });

  it('rejects category store attribution and rolls back a failed purchase', () => {
    const category = createGroup(
      { serverInstanceId, name: 'Breakfast', kind: 'category' },
      database,
    ).group;
    const item = add('Cereal', [category.id]);
    const categoryError = caughtError(() =>
      purchaseEntry(
        item.entryId,
        {
          serverInstanceId,
          expectedRevision: item.entryRevision,
          storeGroupId: category.id,
        },
        database,
      ),
    );
    expect(categoryError).toMatchObject({ code: 'INVALID_STORE' });

    const revisionBefore = getSnapshot(database).revision;
    database.exec(`
      CREATE TRIGGER fail_purchase_insert
      BEFORE INSERT ON purchases
      BEGIN
        SELECT RAISE(ABORT, 'simulated purchase failure');
      END;
    `);
    const rollbackError = caughtError(() =>
      purchaseEntry(
        item.entryId,
        { serverInstanceId, expectedRevision: item.entryRevision },
        database,
      ),
    );
    expect(rollbackError).toMatchObject({
      message: 'simulated purchase failure',
    });
    expect(getSnapshot(database).revision).toBe(revisionBefore);
    expect(getSnapshot(database).entries[0].status).toBe('active');
    expect(getPurchaseHistory(null, database).items).toEqual([]);
  });

  it('keeps historical store and item names unchanged after later edits', () => {
    const aldi = store('Aldi');
    const entry = add('Coffee', [aldi.id]);
    const purchase = purchaseEntry(
      entry.entryId,
      {
        serverInstanceId,
        expectedRevision: entry.entryRevision,
        storeGroupId: aldi.id,
      },
      database,
    );
    const groupRevision = getSnapshot(database).groups[0].revision;
    renameGroup(
      aldi.id,
      {
        serverInstanceId,
        expectedRevision: groupRevision,
        name: 'Aldi Market',
      },
      database,
    );
    const undone = undoPurchase(
      entry.entryId,
      { serverInstanceId, expectedRevision: purchase.entryRevision },
      database,
    );
    editEntry(
      entry.entryId,
      {
        serverInstanceId,
        expectedRevision: undone.entryRevision,
        name: 'Coffee beans',
        quantityText: null,
        note: null,
        groupIds: [aldi.id],
      },
      database,
    );
    expect(getPurchaseHistory(null, database).items).toHaveLength(0);
    expect(
      database
        .prepare(
          'SELECT name_snapshot, store_name_snapshot, voided_at FROM purchases',
        )
        .all(),
    ).toEqual([
      {
        name_snapshot: 'Coffee',
        store_name_snapshot: 'Aldi',
        voided_at: expect.any(String),
      },
    ]);
  });

  it('uses a stable cursor when new purchases arrive between history pages', () => {
    for (let index = 0; index < 51; index += 1) {
      const entry = add(`Page item ${index}`);
      const purchase = purchaseEntry(
        entry.entryId,
        { serverInstanceId, expectedRevision: entry.entryRevision },
        database,
      );
      database
        .prepare('UPDATE purchases SET purchased_at = ? WHERE id = ?')
        .run(
          new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString(),
          purchase.purchaseId,
        );
    }

    const firstPage = getPurchaseHistory(null, database);
    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.nextCursor).not.toBeNull();

    const latest = add('Page item inserted later');
    purchaseEntry(
      latest.entryId,
      { serverInstanceId, expectedRevision: latest.entryRevision },
      database,
    );
    const secondPage = getPurchaseHistory(firstPage.nextCursor, database);

    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0].name).toBe('Page item 0');
    expect(secondPage.items.map((item) => item.id)).not.toContain(
      firstPage.items[0].id,
    );
  });

  it('cancels without adding history and excludes archived groups from effective membership', () => {
    const aisle = store('Aisle 4');
    const cancelled = add('Soap');
    cancelEntry(
      cancelled.entryId,
      { serverInstanceId, expectedRevision: cancelled.entryRevision },
      database,
    );
    expect(getPurchaseHistory(null, database).items).toHaveLength(0);

    const assigned = add('Shampoo', [aisle.id]);
    const group = getSnapshot(database).groups.find(
      (candidate) => candidate.id === aisle.id,
    )!;
    archiveGroup(
      aisle.id,
      { serverInstanceId, expectedRevision: group.revision },
      database,
    );
    const snapshot = getSnapshot(database);
    expect(snapshot.groups.some((candidate) => candidate.id === aisle.id)).toBe(
      false,
    );
    expect(
      snapshot.entries.find((entry) => entry.id === assigned.entryId)?.groupIds,
    ).toEqual([]);
    expect(
      snapshot.catalogItems.find((item) => item.name === 'Shampoo')
        ?.defaultGroupIds,
    ).toEqual([]);
  });

  it('aborts a stale clear as one atomic batch and guards group reorder revisions', () => {
    const first = add('Rice');
    const second = add('Pasta');
    const firstPurchase = purchaseEntry(
      first.entryId,
      { serverInstanceId, expectedRevision: first.entryRevision },
      database,
    );
    const secondPurchase = purchaseEntry(
      second.entryId,
      { serverInstanceId, expectedRevision: second.entryRevision },
      database,
    );
    const clearError = caughtError(() =>
      archivePurchasedEntries(
        {
          serverInstanceId,
          entries: [
            {
              id: first.entryId,
              expectedRevision: firstPurchase.entryRevision,
            },
            {
              id: second.entryId,
              expectedRevision: secondPurchase.entryRevision - 1,
            },
          ],
        },
        database,
      ),
    );
    expect(clearError).toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(
      getSnapshot(database).entries.filter(
        (entry) => entry.status === 'purchased',
      ),
    ).toHaveLength(2);

    const a = store('A');
    const b = store('B');
    const currentGroups = getSnapshot(database).groups;
    const reordered = reorderGroups(
      {
        serverInstanceId,
        groups: [
          { id: b.id, expectedRevision: b.revision, position: 0 },
          { id: a.id, expectedRevision: a.revision, position: 1 },
        ],
      },
      database,
    );
    expect(reordered.changedGroupIds).toHaveLength(2);
    const staleReorderError = caughtError(() =>
      reorderGroups(
        {
          serverInstanceId,
          groups: currentGroups.map((group) => ({
            id: group.id,
            expectedRevision: group.revision,
            position: group.position,
          })),
        },
        database,
      ),
    );
    expect(staleReorderError).toMatchObject({ code: 'REVISION_CONFLICT' });
  });

  it('rejects cross-list group references instead of attaching them to the shared list', () => {
    const otherListId = randomUUID();
    const foreignGroupId = randomUUID();
    database
      .prepare('INSERT INTO lists (id, name) VALUES (?, ?)')
      .run(otherListId, 'Other list');
    database
      .prepare(
        `INSERT INTO groups (id, list_id, name, normalized_name, kind, position)
				 VALUES (?, ?, 'Foreign', 'foreign', 'category', 0)`,
      )
      .run(foreignGroupId, otherListId);

    const error = caughtError(() => add('Milk', [foreignGroupId]));
    expect(error).toMatchObject({ code: 'INVALID_GROUP', status: 400 });
    expect(getSnapshot(database).entries).toEqual([]);
  });
});
