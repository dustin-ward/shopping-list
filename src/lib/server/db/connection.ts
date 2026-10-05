import {
  drizzle,
  type BetterSQLite3Database,
} from 'drizzle-orm/better-sqlite3';
import { getConfig } from '../config.js';
import * as schema from './schema';
import { openSqliteDatabase } from './sqlite.js';

type AppDatabase = BetterSQLite3Database<typeof schema>;

let sqlite: ReturnType<typeof openSqliteDatabase> | undefined;
let database: AppDatabase | undefined;

export function getRawDatabase(): ReturnType<typeof openSqliteDatabase> {
  if (!sqlite) {
    sqlite = openSqliteDatabase(getConfig().databasePath);
  }
  return sqlite;
}

export function getDatabase(): AppDatabase {
  if (!database) {
    database = drizzle(getRawDatabase(), { schema });
  }
  return database;
}

export function closeDatabase(): void {
  database = undefined;
  sqlite?.close();
  sqlite = undefined;
}

// adapter-node emits this only after it stops accepting requests and drains the
// active ones, so the SQLite connection closes after in-flight transactions.
process.once('sveltekit:shutdown' as NodeJS.Signals, closeDatabase);
