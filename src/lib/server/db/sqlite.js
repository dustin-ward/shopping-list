// @ts-check
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Open and configure a SQLite connection used by the application.
 *
 * @param {string} filePath
 */
export function openSqliteDatabase(filePath) {
  const databasePath = filePath === ':memory:' ? filePath : resolve(filePath);
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const database = new Database(databasePath);
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.pragma('synchronous = FULL');
  database.pragma('journal_mode = WAL');
  return database;
}
