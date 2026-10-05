import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readConfig } from '../src/lib/server/config.js';
import { createDatabaseBackup } from '../src/lib/server/db/backup.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = resolve(projectRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

async function main() {
  const config = readConfig(process.env);
  const databasePath = resolve(config.databasePath);
  if (!existsSync(databasePath)) {
    throw new Error(
      'The configured database file does not exist; no backup was created.',
    );
  }

  const backupDirectory = resolve(
    process.argv[2] ?? process.env.BACKUP_DIR ?? '/backups',
  );
  mkdirSync(backupDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const destination = join(
    backupDirectory,
    `shopping-list-${timestamp}-${randomUUID()}.sqlite`,
  );
  await createDatabaseBackup(databasePath, destination);
  console.info(`Verified SQLite backup created: ${destination}`);
}

main().catch((error) => {
  console.error('Database backup failed:', error);
  process.exitCode = 1;
});
