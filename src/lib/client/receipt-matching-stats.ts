/**
 * The matching-stats surface's client half (ticket 18): how each binding source
 * and accepted rank is named, the share a count implies, and the sentences that
 * make the evidence readable. Every label is a pure function of the payload, so
 * the component stays a renderer and the surface can be exercised without a
 * browser.
 *
 * The payload is counts only; percentages are derived here from the total the
 * payload already carries. They are whole percentages, so they may not total
 * exactly 100 — the counts are the exact answer and the reconciliation sentence
 * is what proves every committed line landed in a bucket.
 */

import { ApiError, requestJson } from './api';
import {
  RECEIPT_BOUND_VIA_VALUES,
  type MatchingStats,
  type ReceiptBoundVia,
} from '../shared/schemas';

/** The headline of the empty state: no receipts committed yet. */
const NO_COMMITTED_RECEIPTS = 'No receipts committed yet.';

/** The full empty-state sentence: what the reviewer can do about it. */
export const MATCHING_STATS_EMPTY = `${NO_COMMITTED_RECEIPTS} Commit a reviewed receipt and its line provenance appears here.`;

/** `GET /api/matching-stats`: the committed corpus's provenance. */
export function fetchMatchingStats(): Promise<MatchingStats> {
  return requestJson<MatchingStats>('/api/matching-stats');
}

/** What a binding source is called on the surface. */
export function matchingSourceLabel(source: ReceiptBoundVia): string {
  switch (source) {
    case 'auto':
      return 'Automatic (tier 1)';
    case 'suggested':
      return 'Accepted suggestion (tier 2)';
    case 'manual':
      return 'Chosen manually';
    case 'created':
      return 'Item created in review';
  }
}

/** The same source in a running sentence. */
export function matchingSourceShortLabel(source: ReceiptBoundVia): string {
  switch (source) {
    case 'auto':
      return 'automatic';
    case 'suggested':
      return 'suggested';
    case 'manual':
      return 'manual';
    case 'created':
      return 'created';
  }
}

/** A count's share of the total, as a whole percent; no total means no share. */
export function matchingSharePercent(count: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((count / total) * 100);
}

/** `1 item line` / `12 item lines`. */
function matchingLineCountLabel(count: number): string {
  return plural(count, 'item line');
}

/** `2 committed receipts · 12 item lines`, or the empty state's headline. */
export function matchingStatsHeadline(stats: MatchingStats): string {
  if (stats.committedReceiptCount === 0) return NO_COMMITTED_RECEIPTS;
  return `${plural(stats.committedReceiptCount, 'committed receipt')} · ${matchingLineCountLabel(stats.lineCount)}`;
}

/**
 * The reconciliation the acceptance criterion asks for: every committed item
 * line is in one provenance bucket or in the no-binding residual, so the
 * sentence's parts add up to its total.
 */
export function matchingReconciliation(stats: MatchingStats): string {
  const parts = RECEIPT_BOUND_VIA_VALUES.map((source) => {
    const count = matchingSourceCount(stats, source);
    return `${count} ${matchingSourceShortLabel(source)}`;
  });
  if (stats.noBindingLineCount > 0) {
    parts.push(`${stats.noBindingLineCount} unknown or skipped`);
  }
  const lines = `${stats.lineCount} committed ${
    stats.lineCount === 1 ? 'item line' : 'item lines'
  }`;
  return `${lines}: ${parts.join(', ')}.`;
}

/** One source's count; the payload always carries all four, zeros included. */
function matchingSourceCount(
  stats: MatchingStats,
  source: ReceiptBoundVia,
): number {
  return (
    stats.sources.find((candidate) => candidate.source === source)?.lineCount ??
    0
  );
}

/** One provenance row: the count and the whole-percent share it implies. */
export function matchingSourceShare(
  stats: MatchingStats,
  source: ReceiptBoundVia,
): { count: number; percent: number } {
  const count = matchingSourceCount(stats, source);
  return {
    count,
    percent: matchingSharePercent(count, stats.lineCount),
  };
}

/** The rank section's summary: accepted suggestions, or that there are none. */
export function suggestedRankSummary(stats: MatchingStats): string {
  const { lineCount } = stats.suggested;
  if (lineCount === 0) return 'No accepted suggestions yet.';
  return `${plural(lineCount, 'accepted suggestion')} by rank.`;
}

/** `Rank 1` — the label an accepted suggestion's position goes by. */
export function matchingRankLabel(rank: number): string {
  return `Rank ${rank}`;
}

/** Accepted suggestions stored without a rank, so the distribution reconciles. */
export function unrankedSuggestedNote(stats: MatchingStats): string {
  const { unrankedLineCount } = stats.suggested;
  if (unrankedLineCount === 0) return '';
  return `${plural(unrankedLineCount, 'accepted suggestion')} ${
    unrankedLineCount === 1 ? 'has' : 'have'
  } no rank recorded.`;
}

/** `n singular` / `n plural` — the `s` pluralisation this surface needs. */
function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

/** One refusal sentence for the surface's read. */
export function matchingStatsErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Matching stats are unavailable. Refresh and try again.';
}
