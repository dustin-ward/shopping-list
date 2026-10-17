import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  real,
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

export const receipts = sqliteTable(
  'receipts',
  {
    id: text('id').primaryKey(),
    listId: text('list_id')
      .notNull()
      .references(() => lists.id),
    status: text('status')
      .notNull()
      .default('pending')
      .$type<
        | 'pending'
        | 'processing'
        | 'review'
        | 'committed'
        | 'discarded'
        | 'failed'
      >(),
    imagePath: text('image_path'),
    imageBytes: integer('image_bytes'),
    sha256: text('sha256').notNull(),
    ocrJson: text('ocr_json'),
    ocrWarnings: text('ocr_warnings'),
    currency: text('currency'),
    subtotalMinor: integer('subtotal_minor'),
    taxMinor: integer('tax_minor'),
    totalMinor: integer('total_minor'),
    capturedAt: text('captured_at'),
    storeGroupId: text('store_group_id').references(() => groups.id),
    parseVersion: integer('parse_version').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    processedAt: text('processed_at'),
    committedAt: text('committed_at'),
    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at'),
  },
  (table) => [
    index('receipts_status_work_queue').on(table.status, table.createdAt),
    index('receipts_list_status').on(
      table.listId,
      table.status,
      table.createdAt,
    ),
    check(
      'receipts_status_check',
      sql`${table.status} IN ('pending', 'processing', 'review', 'committed', 'discarded', 'failed')`,
    ),
    check(
      'receipts_nonnegative_parse_version',
      sql`${table.parseVersion} >= 0`,
    ),
    check('receipts_nonnegative_attempts', sql`${table.attempts} >= 0`),
    check(
      'receipts_committed_requires_store',
      sql`${table.status} <> 'committed' OR ${table.storeGroupId} IS NOT NULL`,
    ),
  ],
);

export const receiptLines = sqliteTable(
  'receipt_lines',
  {
    id: text('id').primaryKey(),
    receiptId: text('receipt_id')
      .notNull()
      .references(() => receipts.id, { onDelete: 'cascade' }),
    lineIndex: integer('line_index').notNull(),
    rawText: text('raw_text').notNull(),
    parsedName: text('parsed_name'),
    quantityReal: real('quantity_real'),
    quantityText: text('quantity_text'),
    quantityUnit: text('quantity_unit').$type<
      'lb' | 'kg' | 'oz' | 'g' | 'l' | 'ml' | 'ea'
    >(),
    unitPriceMinor: integer('unit_price_minor'),
    totalPriceMinor: integer('total_price_minor'),
    isItemChunk: integer('is_item_chunk', { mode: 'boolean' }).notNull(),
    confidence: real('confidence'),
    catalogItemId: text('catalog_item_id').references(() => catalogItems.id),
    reviewState: text('review_state')
      .notNull()
      .default('unreviewed')
      .$type<'unreviewed' | 'bound' | 'new' | 'unknown' | 'skipped'>(),
    boundVia: text('bound_via').$type<
      'auto' | 'suggested' | 'manual' | 'created'
    >(),
    boundRank: integer('bound_rank'),
    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at'),
  },
  (table) => [
    index('receipt_lines_receipt').on(table.receiptId, table.lineIndex),
    index('receipt_lines_catalog').on(table.catalogItemId),
    check('receipt_lines_nonnegative_line_index', sql`${table.lineIndex} >= 0`),
    check(
      'receipt_lines_quantity_unit_check',
      sql`${table.quantityUnit} IS NULL OR ${table.quantityUnit} IN ('lb', 'kg', 'oz', 'g', 'l', 'ml', 'ea')`,
    ),
    check(
      'receipt_lines_review_state_check',
      sql`${table.reviewState} IN ('unreviewed', 'bound', 'new', 'unknown', 'skipped')`,
    ),
    check(
      'receipt_lines_bound_via_check',
      sql`${table.boundVia} IS NULL OR ${table.boundVia} IN ('auto', 'suggested', 'manual', 'created')`,
    ),
    check(
      'receipt_lines_positive_bound_rank',
      sql`${table.boundRank} IS NULL OR ${table.boundRank} >= 1`,
    ),
  ],
);

export const itemAliases = sqliteTable(
  'item_aliases',
  {
    id: text('id').primaryKey(),
    listId: text('list_id')
      .notNull()
      .references(() => lists.id),
    catalogItemId: text('catalog_item_id')
      .notNull()
      .references(() => catalogItems.id),
    aliasText: text('alias_text').notNull(),
    normalizedAlias: text('normalized_alias').notNull(),
    source: text('source').notNull().$type<'manual' | 'review' | 'auto'>(),
    createdByReceiptLineId: text('created_by_receipt_line_id').references(
      () => receiptLines.id,
    ),
    deletedAt: text('deleted_at'),
    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at'),
  },
  (table) => [
    uniqueIndex('item_aliases_live_unique')
      .on(table.listId, table.catalogItemId, table.normalizedAlias)
      .where(sql`${table.deletedAt} IS NULL`),
    index('item_aliases_lookup').on(table.listId, table.normalizedAlias),
    check(
      'item_aliases_source_check',
      sql`${table.source} IN ('manual', 'review', 'auto')`,
    ),
  ],
);
