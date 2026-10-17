import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readConfig } from '../src/lib/server/config.js';
import { migrateAndBootstrap } from '../src/lib/server/db/lifecycle.js';
import { openSqliteDatabase } from '../src/lib/server/db/sqlite.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = resolve(projectRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

async function start() {
  const config = readConfig(process.env);
  const database = openSqliteDatabase(config.databasePath);
  try {
    migrateAndBootstrap(database, resolve(projectRoot, 'migrations'));
  } finally {
    database.close();
  }

  const child = spawn(
    process.execPath,
    [resolve(projectRoot, 'build/index.js')],
    {
      cwd: projectRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        PORT: String(config.port),
        ORIGIN: config.canonicalOrigin,
        SERVER_INSTANCE_ID: randomUUID(),
        // adapter-node defaults to 512 KB, which rejects receipt uploads before
        // hooks run; the route still caps images at 10 MB itself.
        BODY_SIZE_LIMIT: process.env.BODY_SIZE_LIMIT ?? '12M',
      },
    },
  );

  /** @type {NodeJS.Signals[]} */
  const shutdownSignals = ['SIGINT', 'SIGTERM'];
  for (const signal of shutdownSignals) {
    process.once(signal, () => child.kill(signal));
  }

  const result = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  process.exitCode =
    result.code ??
    (result.signal === 'SIGTERM' || result.signal === 'SIGINT' ? 0 : 1);
}

start().catch((error) => {
  console.error('Application startup failed:', error);
  process.exitCode = 1;
});
