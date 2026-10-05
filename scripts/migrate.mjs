import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readConfig } from '../src/lib/server/config.js';
import { migrateAndBootstrap } from '../src/lib/server/db/lifecycle.js';
import { openSqliteDatabase } from '../src/lib/server/db/sqlite.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = resolve(projectRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = readConfig(process.env);
const migrationsFolder = resolve(projectRoot, 'migrations');
const database = openSqliteDatabase(config.databasePath);

try {
  migrateAndBootstrap(database, migrationsFolder);
  console.info('Database migrations and shared-list bootstrap completed.');
} catch (error) {
  console.error('Database initialization failed:', error);
  process.exitCode = 1;
} finally {
  database.close();
}
