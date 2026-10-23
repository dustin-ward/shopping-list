/**
 * The suggestion telemetry's rules (ticket 18; plan §7 "Learning loop": every
 * committed line records its binding provenance from R1, and the R2
 * suggestion-telemetry counters read it).
 *
 * The rules are pure and live here so they read without a database: the
 * denominator is every committed item line, the four `bound_via` sources are
 * always present in canonical order, and a line with no provenance (an unknown
 * or skipped line — a committed observation rather than a binding) is the
 * residual that keeps the buckets reconciling with the committed lines. The
 * rank distribution is over accepted suggestions only; a suggested line stored
 * without a rank is reported as unranked rather than dropped.
 */

import {
  RECEIPT_BOUND_VIA_VALUES,
  type MatchingStats,
  type ReceiptBoundVia,
} from '../../shared/schemas';

/** One committed item line, as the telemetry counts it. */
export type MatchingStatsLine = {
  boundVia: ReceiptBoundVia | null;
  boundRank: number | null;
};

/** Count committed item lines into the provenance and rank buckets. */
export function computeMatchingStats(
  committedReceiptCount: number,
  lines: readonly MatchingStatsLine[],
): MatchingStats {
  const sources = RECEIPT_BOUND_VIA_VALUES.map((source) => ({
    source,
    lineCount: lines.filter((line) => line.boundVia === source).length,
  }));

  const suggestedLines = lines.filter((line) => line.boundVia === 'suggested');
  const rankCounts = new Map<number, number>();
  let unrankedLineCount = 0;
  for (const line of suggestedLines) {
    if (line.boundRank === null) {
      unrankedLineCount += 1;
      continue;
    }
    rankCounts.set(line.boundRank, (rankCounts.get(line.boundRank) ?? 0) + 1);
  }

  return {
    committedReceiptCount,
    lineCount: lines.length,
    noBindingLineCount: lines.filter((line) => line.boundVia === null).length,
    sources,
    suggested: {
      lineCount: suggestedLines.length,
      ranks: [...rankCounts.entries()]
        .sort(([left], [right]) => left - right)
        .map(([rank, lineCount]) => ({ rank, lineCount })),
      unrankedLineCount,
    },
  };
}
