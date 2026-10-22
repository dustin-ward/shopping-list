import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getServerInstanceId } from '../../src/lib/server/instance';
import { UPLOAD_SPOOL_PREFIX } from '../../src/lib/server/receipts/upload-spool.js';
import { acceptReceiptUpload } from '../../src/lib/server/services/receipts';
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

/** A minimal multipart upload request, mirroring the upload route's client. */
function receiptUploadRequest(bytes: Buffer): Request {
  const body = new FormData();
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  body.set('image', new Blob([copy], { type: 'image/jpeg' }), 'receipt.jpg');
  return new Request('http://localhost:5173/api/receipts', {
    method: 'POST',
    body,
    headers: { 'x-server-instance-id': getServerInstanceId() },
  });
}

describe('backup command', () => {
  it('archives the database and the receipt images, and restores both', async () => {
    const storageDir = join(directory, 'receipts');
    const backupDir = join(directory, 'backups');
    const image = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(300, 0x42),
    ]);
    const captured = await acceptReceiptUpload(
      receiptUploadRequest(image),
      database,
      storageDir,
    );
    // An in-flight upload spool file is a partial request body, not a receipt.
    writeFileSync(
      join(storageDir, `${UPLOAD_SPOOL_PREFIX}00000000`),
      'partial upload',
    );

    const output = execFileSync(
      process.execPath,
      ['scripts/backup.mjs', backupDir],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          CANONICAL_ORIGIN: 'http://localhost:5173',
          DATABASE_PATH: sourcePath,
          RECEIPT_STORAGE_DIR: storageDir,
        },
      },
    );

    const artifacts = readdirSync(backupDir).sort();
    expect(artifacts).toHaveLength(2);
    const databaseArtifact = artifacts.find((name) => name.endsWith('.sqlite'));
    const imagesArtifact = artifacts.find((name) =>
      name.endsWith('-receipts.tar'),
    );
    expect(databaseArtifact).toBeDefined();
    expect(imagesArtifact).toBeDefined();
    // The two halves of one backup run share a name, so a restore cannot pair
    // yesterday's database with today's images by accident.
    expect(databaseArtifact?.replace(/\.sqlite$/u, '-receipts.tar')).toBe(
      imagesArtifact,
    );
    expect(output).toContain(databaseArtifact as string);
    expect(output).toContain(imagesArtifact as string);

    // Restore the evidence into a fresh directory, the documented procedure.
    const restoredImages = join(directory, 'restored', 'receipts');
    mkdirSync(restoredImages, { recursive: true });
    execFileSync('tar', [
      '-xf',
      join(backupDir, imagesArtifact as string),
      '-C',
      restoredImages,
      '--no-same-owner',
    ]);
    expect(readdirSync(restoredImages)).toEqual([`${captured.id}.jpg`]);
    expect(readFileSync(join(restoredImages, `${captured.id}.jpg`))).toEqual(
      image,
    );

    const restoredDatabase = openSqliteDatabase(
      join(backupDir, databaseArtifact as string),
    );
    try {
      migrateAndBootstrap(
        restoredDatabase,
        resolve(process.cwd(), 'migrations'),
      );
      expect(restoredDatabase.pragma('integrity_check')).toEqual([
        { integrity_check: 'ok' },
      ]);
      expect(restoredDatabase.pragma('foreign_key_check')).toEqual([]);
      const restored = restoredDatabase
        .prepare('SELECT id, image_path, sha256 FROM receipts')
        .all() as { id: string; image_path: string; sha256: string }[];
      expect(restored).toHaveLength(1);
      // The restored row and the restored file are the same capture: the
      // database's digest matches the bytes the archive restored.
      expect(restored[0]).toMatchObject({
        id: captured.id,
        image_path: `${captured.id}.jpg`,
        sha256: createHash('sha256').update(image).digest('hex'),
      });
      expect(existsSync(join(restoredImages, restored[0].image_path))).toBe(
        true,
      );
    } finally {
      restoredDatabase.close();
    }
  });
});
