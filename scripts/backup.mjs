import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readConfig } from '../src/lib/server/config.js';
import { createDirectoryArchive } from '../src/lib/server/db/archive.js';
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
  // One run id names both halves of the backup, so a restore pairs them.
  const runId = `${timestamp}-${randomUUID()}`;

  // The database first: with images retained (the capture-first default) this
  // order guarantees every image the backed-up rows reference is also in the
  // archive, while a spare image is harmless.
  const destination = join(backupDirectory, `shopping-list-${runId}.sqlite`);
  await createDatabaseBackup(databasePath, destination);
  console.info(`Verified SQLite backup created: ${destination}`);

  const imagesDestination = join(
    backupDirectory,
    `shopping-list-${runId}-receipts.tar`,
  );
  const images = createDirectoryArchive(
    config.receiptStorageDir,
    imagesDestination,
  );
  console.info(
    `Receipt image archive created: ${imagesDestination} ` +
      `(${images.fileCount} images, ${images.totalBytes} bytes)`,
  );
}

main().catch((error) => {
  console.error('Backup failed:', error);
  process.exitCode = 1;
});
