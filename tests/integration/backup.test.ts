import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getServerInstanceId } from '../../src/lib/server/instance';
import { createDatabaseBackup } from '../../src/lib/server/db/backup.js';
import { migrateAndBootstrap } from '../../src/lib/server/db/lifecycle.js';
import { openSqliteDatabase } from '../../src/lib/server/db/sqlite.js';
import {
  addEntry,
  purchaseEntry,
  undoPurchase,
} from '../../src/lib/server/services/entries';
import { createGroup } from '../../src/lib/server/services/groups';
import { getPurchaseHistory } from '../../src/lib/server/services/purchases';
import { getSnapshot } from '../../src/lib/server/services/snapshot';

let directory = '';
let sourcePath = '';
let database: ReturnType<typeof openSqliteDatabase>;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'shopping-list-backup-'));
  sourcePath = join(directory, 'source.sqlite');
  database = openSqliteDatabase(sourcePath);
  migrateAndBootstrap(database, resolve(process.cwd(), 'migrations'));
});

afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('online SQLite backup', () => {
  it('restores current list and valid/voided purchase history from the backup', async () => {
    const serverInstanceId = getServerInstanceId();
    const store = createGroup(
      { serverInstanceId, name: 'Corner shop', kind: 'store' },
      database,
    ).group;
    const entry = addEntry(
      {
        id: randomUUID(),
        serverInstanceId,
        name: 'Tea',
        quantityText: '2 boxes',
        note: 'Breakfast',
        groupIds: [store.id],
      },
      database,
    );
    const firstPurchase = purchaseEntry(
      entry.entryId,
      {
        serverInstanceId,
        expectedRevision: entry.entryRevision,
        storeGroupId: store.id,
      },
      database,
    );
    const undone = undoPurchase(
      entry.entryId,
      { serverInstanceId, expectedRevision: firstPurchase.entryRevision },
      database,
    );
    purchaseEntry(
      entry.entryId,
      {
        serverInstanceId,
        expectedRevision: undone.entryRevision,
        storeGroupId: store.id,
      },
      database,
    );

    const sourceSnapshot = getSnapshot(database);
    const sourceHistory = getPurchaseHistory(null, database);
    const backupPath = join(directory, 'backups', 'verified.sqlite');
    await createDatabaseBackup(sourcePath, backupPath);
    expect(readdirSync(join(directory, 'backups'))).toEqual([
      'verified.sqlite',
    ]);
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);

    const restored = openSqliteDatabase(backupPath);
    try {
      migrateAndBootstrap(restored, resolve(process.cwd(), 'migrations'));
      expect(getSnapshot(restored)).toEqual(sourceSnapshot);
      expect(getPurchaseHistory(null, restored)).toEqual(sourceHistory);
      expect(
        restored
          .prepare(
            'SELECT COUNT(*) AS count FROM purchases WHERE voided_at IS NOT NULL',
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(restored.pragma('integrity_check')).toEqual([
        { integrity_check: 'ok' },
      ]);
      expect(restored.pragma('foreign_key_check')).toEqual([]);
    } finally {
      restored.close();
    }
  });
});
