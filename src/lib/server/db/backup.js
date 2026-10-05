// @ts-check
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { openSqliteDatabase } from './sqlite.js';

/**
 * Create and verify an online SQLite backup without copying a live database file.
 *
 * @param {string} sourcePath
 * @param {string} destinationPath
 */
export async function createDatabaseBackup(sourcePath, destinationPath) {
  const destination = resolve(destinationPath);
  if (existsSync(destination)) {
    throw new Error(
      'The backup destination already exists; it was not overwritten.',
    );
  }
  mkdirSync(dirname(destination), { recursive: true });
  const source = openSqliteDatabase(sourcePath);
  try {
    await source.backup(destination);
    const backup = new Database(destination, {
      fileMustExist: true,
    });
    try {
      backup.pragma('foreign_keys = ON');
      backup.pragma('wal_checkpoint(TRUNCATE)');
      const journalMode = backup.pragma('journal_mode = DELETE', {
        simple: true,
      });
      if (journalMode !== 'delete') {
        throw new Error(
          'The backup could not be checkpointed to a standalone SQLite file.',
        );
      }
      const integrity = /** @type {{ integrity_check: string }[]} */ (
        backup.pragma('integrity_check')
      );
      if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
        throw new Error('The backup failed SQLite integrity_check.');
      }
      const foreignKeyFailures = /** @type {unknown[]} */ (
        backup.pragma('foreign_key_check')
      );
      if (foreignKeyFailures.length > 0) {
        throw new Error('The backup contains foreign-key violations.');
      }
    } finally {
      backup.close();
    }
    rmSync(`${destination}-wal`, { force: true });
    rmSync(`${destination}-shm`, { force: true });
    chmodSync(destination, 0o600);
  } catch (error) {
    if (existsSync(destination)) rmSync(destination);
    throw error;
  } finally {
    source.close();
  }
}
