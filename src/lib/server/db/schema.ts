import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const timestamp = (name: string) =>
  text(name)
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);

export const lists = sqliteTable('lists', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
});

export const appState = sqliteTable(
  'app_state',
  {
    id: integer('id').primaryKey(),
    listId: text('list_id')
      .notNull()
      .unique()
      .references(() => lists.id),
    revision: integer('revision').notNull().default(0),
    updatedAt: timestamp('updated_at'),
  },
  (table) => [
    check('app_state_singleton_id', sql`${table.id} = 1`),
    check('app_state_nonnegative_revision', sql`${table.revision} >= 0`),
  ],
);

export const catalogItems = sqliteTable(
  'catalog_items',
  {
    id: text('id').primaryKey(),
    listId: text('list_id')
      .notNull()
      .references(() => lists.id),
    displayName: text('display_name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at'),
  },
  (table) => [
    uniqueIndex('catalog_items_list_normalized_name_unique').on(
      table.listId,
      table.normalizedName,
    ),
  ],
);

export const groups = sqliteTable(
  'groups',
  {
    id: text('id').primaryKey(),
    listId: text('list_id')
      .notNull()
      .references(() => lists.id),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    kind: text('kind').notNull().$type<'store' | 'category'>(),
    color: text('color').notNull().default('#d6a453'),
    position: integer('position').notNull(),
    revision: integer('revision').notNull().default(1),
    archivedAt: text('archived_at'),
    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at'),
  },
  (table) => [
    uniqueIndex('groups_live_name_unique')
      .on(table.listId, table.normalizedName)
      .where(sql`${table.archivedAt} IS NULL`),
    index('groups_list_position_index').on(table.listId, table.position),
    check('groups_kind_check', sql`${table.kind} IN ('store', 'category')`),
    check('groups_nonnegative_position', sql`${table.position} >= 0`),
    check('groups_positive_revision', sql`${table.revision} > 0`),
  ],
);

export const catalogItemGroups = sqliteTable(
  'catalog_item_groups',
  {
    catalogItemId: text('catalog_item_id')
      .notNull()
      .references(() => catalogItems.id),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id),
  },
  (table) => [
    primaryKey({ columns: [table.catalogItemId, table.groupId] }),
    index('catalog_item_groups_group_index').on(table.groupId),
  ],
);

export const listEntries = sqliteTable(
  'list_entries',
  {
    id: text('id').primaryKey(),
    listId: text('list_id')
      .notNull()
      .references(() => lists.id),
    catalogItemId: text('catalog_item_id')
      .notNull()
      .references(() => catalogItems.id),
    name: text('name').notNull(),
    quantityText: text('quantity_text'),
    note: text('note'),
    status: text('status')
      .notNull()
      .default('active')
      .$type<'active' | 'purchased' | 'cancelled'>(),
    revision: integer('revision').notNull().default(1),
    completedAt: text('completed_at'),
    archivedAt: text('archived_at'),
    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at'),
  },
  (table) => [
    uniqueIndex('list_entries_one_active_item_unique')
      .on(table.listId, table.catalogItemId)
      .where(sql`${table.status} = 'active' AND ${table.archivedAt} IS NULL`),
    index('list_entries_current_index').on(
      table.listId,
      table.status,
      table.archivedAt,
      table.createdAt,
    ),
    check(
      'list_entries_status_check',
      sql`${table.status} IN ('active', 'purchased', 'cancelled')`,
    ),
    check('list_entries_positive_revision', sql`${table.revision} > 0`),
    check(
      'list_entries_consistent_state',
      sql`(
				(${table.status} = 'active' AND ${table.completedAt} IS NULL AND ${table.archivedAt} IS NULL)
				OR (${table.status} = 'purchased' AND ${table.completedAt} IS NOT NULL)
				OR (${table.status} = 'cancelled' AND ${table.completedAt} IS NULL AND ${table.archivedAt} IS NOT NULL)
			)`,
    ),
  ],
);

export const entryGroups = sqliteTable(
  'entry_groups',
  {
    entryId: text('entry_id')
      .notNull()
      .references(() => listEntries.id),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id),
  },
  (table) => [
    primaryKey({ columns: [table.entryId, table.groupId] }),
    index('entry_groups_group_index').on(table.groupId),
  ],
);

export const purchases = sqliteTable(
  'purchases',
  {
    id: text('id').primaryKey(),
    entryId: text('entry_id')
      .notNull()
      .references(() => listEntries.id),
    catalogItemId: text('catalog_item_id')
      .notNull()
      .references(() => catalogItems.id),
    nameSnapshot: text('name_snapshot').notNull(),
    quantitySnapshot: text('quantity_snapshot'),
    noteSnapshot: text('note_snapshot'),
    purchasedAt: timestamp('purchased_at'),
    storeGroupId: text('store_group_id').references(() => groups.id),
    storeNameSnapshot: text('store_name_snapshot'),
    voidedAt: text('voided_at'),
  },
  (table) => [
    uniqueIndex('purchases_one_valid_per_entry_unique')
      .on(table.entryId)
      .where(sql`${table.voidedAt} IS NULL`),
    index('purchases_catalog_item_time_index').on(
      table.catalogItemId,
      table.purchasedAt,
    ),
    index('purchases_time_index').on(table.purchasedAt, table.id),
    check(
      'purchases_store_snapshot_consistency',
      sql`(${table.storeGroupId} IS NULL AND ${table.storeNameSnapshot} IS NULL)
				OR (${table.storeGroupId} IS NOT NULL AND ${table.storeNameSnapshot} IS NOT NULL)`,
    ),
  ],
);
