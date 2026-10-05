import { z } from 'zod';
import type { PurchaseHistoryPage } from '../../shared/schemas';
import { AppError } from '../errors';
import { getRawDatabase } from '../db/connection';
import { currentListId, type SqliteDatabase } from './common';

const PAGE_SIZE = 50;
const cursorSchema = z.object({
  purchasedAt: z.string().min(1).max(40),
  id: z.uuid(),
});

type PurchaseRow = {
  id: string;
  name_snapshot: string;
  quantity_snapshot: string | null;
  purchased_at: string;
  store_name_snapshot: string | null;
};

type PurchaseCursor = z.infer<typeof cursorSchema>;

function decodeCursor(
  cursor: string | null | undefined,
): PurchaseCursor | null {
  if (!cursor) return null;
  if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) {
    throw new AppError(
      400,
      'INVALID_CURSOR',
      'The purchase-history cursor is invalid.',
    );
  }

  try {
    const decoded = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as unknown;
    const result = cursorSchema.safeParse(decoded);
    if (!result.success || Number.isNaN(Date.parse(result.data.purchasedAt))) {
      throw new Error('Invalid cursor fields.');
    }
    return result.data;
  } catch {
    throw new AppError(
      400,
      'INVALID_CURSOR',
      'The purchase-history cursor is invalid.',
    );
  }
}

function encodeCursor(cursor: PurchaseCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function getPurchaseHistory(
  cursor: string | null | undefined,
  database: SqliteDatabase = getRawDatabase(),
): PurchaseHistoryPage {
  const decodedCursor = decodeCursor(cursor);
  return database.transaction(() => {
    const listId = currentListId(database);
    const rows = decodedCursor
      ? (database
          .prepare(
            `SELECT p.id, p.name_snapshot, p.quantity_snapshot, p.purchased_at,
						        p.store_name_snapshot
						 FROM purchases p
						 JOIN list_entries e ON e.id = p.entry_id
						 WHERE e.list_id = ? AND p.voided_at IS NULL
						   AND (p.purchased_at < ? OR (p.purchased_at = ? AND p.id < ?))
						 ORDER BY p.purchased_at DESC, p.id DESC
						 LIMIT ?`,
          )
          .all(
            listId,
            decodedCursor.purchasedAt,
            decodedCursor.purchasedAt,
            decodedCursor.id,
            PAGE_SIZE + 1,
          ) as PurchaseRow[])
      : (database
          .prepare(
            `SELECT p.id, p.name_snapshot, p.quantity_snapshot, p.purchased_at,
						        p.store_name_snapshot
						 FROM purchases p
						 JOIN list_entries e ON e.id = p.entry_id
						 WHERE e.list_id = ? AND p.voided_at IS NULL
						 ORDER BY p.purchased_at DESC, p.id DESC
						 LIMIT ?`,
          )
          .all(listId, PAGE_SIZE + 1) as PurchaseRow[]);

    const hasMore = rows.length > PAGE_SIZE;
    const pageRows = rows.slice(0, PAGE_SIZE);
    const lastRow = pageRows.at(-1);
    return {
      items: pageRows.map((row) => ({
        id: row.id,
        name: row.name_snapshot,
        quantityText: row.quantity_snapshot,
        purchasedAt: row.purchased_at,
        storeName: row.store_name_snapshot,
      })),
      nextCursor:
        hasMore && lastRow
          ? encodeCursor({ purchasedAt: lastRow.purchased_at, id: lastRow.id })
          : null,
    };
  })();
}
