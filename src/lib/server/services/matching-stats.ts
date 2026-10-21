/**
 * Suggestion telemetry (ticket 18; plan §7 "Learning loop": every committed line
 * records its binding provenance from R1 — `bound_via` plus the accepted
 * suggestion's rank — and the R2 suggestion-telemetry counters read it; plan §13
 * "R2 — matching maturity").
 *
 * Reading only. The evidence base is the committed receipts of this list: their
 * item lines grouped by how they found an item (tier 1 auto-bind, an accepted
 * tier-2 suggestion, a manual pick, or an item created during review) and, for
 * accepted suggestions, by the rank the reviewer accepted. Unknown and skipped
 * lines are committed observations rather than bindings; they are reported as
 * the no-binding residual so the shares reconcile with the committed lines
 * instead of quietly shrinking the denominator.
 *
 * Parked rows are not purchased things, so they are outside every bucket. The
 * payload is counts only — the surface divides by the total it already has —
 * and, like every receipt read, it stays out of the snapshot.
 */

import type { MatchingStats } from '../../shared/schemas';
import { getRawDatabase } from '../db/connection';
import {
  computeMatchingStats,
  type MatchingStatsLine,
} from '../receipts/matching-stats';
import { currentListId, type SqliteDatabase } from './common';

/** The telemetry for this list's committed receipts. */
export function listMatchingStats(
  database: SqliteDatabase = getRawDatabase(),
): MatchingStats {
  const listId = currentListId(database);
  const committedReceiptCount = (
    database
      .prepare(
        `SELECT COUNT(*) AS count
           FROM receipts
          WHERE list_id = ? AND status = 'committed'`,
      )
      .get(listId) as { count: number }
  ).count;

  const lines = database
    .prepare(
      `SELECT l.bound_via AS boundVia, l.bound_rank AS boundRank
         FROM receipt_lines l
         JOIN receipts r ON r.id = l.receipt_id
        WHERE r.list_id = ? AND r.status = 'committed' AND l.is_item_chunk = 1`,
    )
    .all(listId) as MatchingStatsLine[];

  return computeMatchingStats(committedReceiptCount, lines);
}
