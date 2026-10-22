/**
 * Price history reads (ticket 20; plan §8 "Prices API", §13 "R3 — price
 * collation"): the committed receipt lines of one canonical item, per store
 * group, with within-family unit normalization.
 *
 * Only a committed receipt is price history. The line must be an item chunk
 * bound to this item (`bound` or `new`; a committed `unknown`/`skipped` line
 * carries no item — plan §8 excludes unknown lines from canonical price views),
 * and both the receipt and the store must belong to this list. One statement
 * reads every such line in chronological order — there is no per-store or
 * per-family query — and the pure rules in `receipts/price-history.ts` fold
 * them into the answer.
 */

import type { ItemPrices } from '../../shared/schemas';
import { getConfig } from '../config.js';
import { getRawDatabase } from '../db/connection';
import { notFound } from '../errors';
import {
  summarizeItemPrices,
  type PriceHistoryRow,
} from '../receipts/price-history';
import { currentListId, type SqliteDatabase } from './common';

type ItemRow = { id: string; name: string };

/**
 * The item's price history, newest store first, or a 404 when the item is not
 * on this list. An item with no committed receipts is a valid, empty history.
 * Currency is the configured receipt currency: multi-currency is out of scope.
 */
export function getItemPrices(
  catalogItemId: string,
  database: SqliteDatabase = getRawDatabase(),
  currency: string = getConfig().receiptCurrency,
): ItemPrices {
  const listId = currentListId(database);
  const item = database
    .prepare(
      `SELECT id, display_name AS name
         FROM catalog_items
        WHERE id = ? AND list_id = ?`,
    )
    .get(catalogItemId, listId) as ItemRow | undefined;
  if (!item) throw notFound('Item not found.');

  const rows = database
    .prepare(
      `SELECT r.store_group_id AS storeGroupId,
              g.name AS storeName,
              r.id AS receiptId,
              r.created_at AS receiptCreatedAt,
              l.id AS lineId,
              l.raw_text AS printedText,
              l.total_price_minor AS totalPriceMinor,
              l.unit_price_minor AS unitPriceMinor,
              l.quantity_real AS quantityReal,
              l.quantity_unit AS quantityUnit
         FROM receipt_lines l
         JOIN receipts r ON r.id = l.receipt_id
         JOIN groups g ON g.id = r.store_group_id
        WHERE r.list_id = ?
          AND g.list_id = ?
          AND r.status = 'committed'
          AND l.catalog_item_id = ?
          AND l.is_item_chunk = 1
          AND l.review_state IN ('bound', 'new')
        ORDER BY r.created_at, r.id, l.line_index, l.id`,
    )
    .all(listId, listId, catalogItemId) as PriceHistoryRow[];

  return summarizeItemPrices(item, currency, rows);
}
