import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateAndBootstrap } from '../../src/lib/server/db/lifecycle.js';
import { openSqliteDatabase } from '../../src/lib/server/db/sqlite.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('database initialization', () => {
  it('migrates and bootstraps one shared list idempotently', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shopping-list-test-'));
    temporaryDirectories.push(directory);
    const database = openSqliteDatabase(
      join(directory, 'shopping-list.sqlite'),
    );

    try {
      const migrationsFolder = resolve(process.cwd(), 'migrations');
      migrateAndBootstrap(database, migrationsFolder);
      migrateAndBootstrap(database, migrationsFolder);

      expect(
        database.prepare('SELECT COUNT(*) AS count FROM lists').get(),
      ).toEqual({ count: 1 });
      expect(
        database.prepare('SELECT revision FROM app_state WHERE id = 1').get(),
      ).toEqual({ revision: 0 });
      expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(database.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(database.pragma('busy_timeout', { simple: true })).toBe(5000);
      expect(database.pragma('synchronous', { simple: true })).toBe(2);
      expect(database.pragma('foreign_key_check')).toEqual([]);
    } finally {
      database.close();
    }
  });
});
