// @ts-check
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

/**
 * Apply committed migrations and create the shared list exactly once.
 *
 * @param {import('better-sqlite3').Database} database
 * @param {string} migrationsFolder
 */
export function migrateAndBootstrap(database, migrationsFolder) {
  migrate(drizzle(database), { migrationsFolder });
  bootstrapSharedList(database);
}

/**
 * Idempotently seed the first shared list and its singleton revision row.
 *
 * @param {import('better-sqlite3').Database} database
 */
export function bootstrapSharedList(database) {
  const bootstrap = database.transaction(() => {
    const state = database
      .prepare('SELECT id FROM app_state WHERE id = 1')
      .get();
    if (state) return;

    let list = /** @type {{ id: string } | undefined} */ (
      database
        .prepare('SELECT id FROM lists ORDER BY created_at, id LIMIT 1')
        .get()
    );
    if (!list) {
      const id = randomUUID();
      database
        .prepare('INSERT INTO lists (id, name) VALUES (?, ?)')
        .run(id, 'Shared shopping list');
      list = { id };
    }

    database
      .prepare('INSERT INTO app_state (id, list_id, revision) VALUES (1, ?, 0)')
      .run(list.id);
  });

  bootstrap.immediate();
}
