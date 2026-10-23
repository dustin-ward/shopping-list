import { describe, expect, it } from 'vitest';
import {
  computeMatchingStats,
  type MatchingStatsLine,
} from '../../src/lib/server/receipts/matching-stats';

/**
 * The suggestion telemetry's pure half (ticket 18): the share of committed item
 * lines by `bound_via`, and the acceptance distribution by accepted suggestion
 * rank. Every bucket reconciles with the committed lines it claims to describe.
 */

function line(overrides: Partial<MatchingStatsLine> = {}): MatchingStatsLine {
  return { boundVia: 'manual', boundRank: null, ...overrides };
}

describe('computeMatchingStats', () => {
  it('is empty when no receipts are committed', () => {
    expect(computeMatchingStats(0, [])).toEqual({
      committedReceiptCount: 0,
      lineCount: 0,
      noBindingLineCount: 0,
      sources: [
        { source: 'auto', lineCount: 0 },
        { source: 'suggested', lineCount: 0 },
        { source: 'manual', lineCount: 0 },
        { source: 'created', lineCount: 0 },
      ],
      suggested: { lineCount: 0, ranks: [], unrankedLineCount: 0 },
    });
  });

  it('counts every committed item line into one provenance bucket or the residual', () => {
    const stats = computeMatchingStats(3, [
      line({ boundVia: 'auto' }),
      line({ boundVia: 'auto' }),
      line({ boundVia: 'suggested', boundRank: 1 }),
      line({ boundVia: 'manual' }),
      line({ boundVia: 'created' }),
      line({ boundVia: null }),
      line({ boundVia: null }),
    ]);

    expect(stats.committedReceiptCount).toBe(3);
    expect(stats.lineCount).toBe(7);
    expect(stats.sources).toEqual([
      { source: 'auto', lineCount: 2 },
      { source: 'suggested', lineCount: 1 },
      { source: 'manual', lineCount: 1 },
      { source: 'created', lineCount: 1 },
    ]);
    expect(stats.noBindingLineCount).toBe(2);
    // The acceptance criterion: the buckets reconcile with the committed lines.
    const bucketed = stats.sources.reduce(
      (total, source) => total + source.lineCount,
      stats.noBindingLineCount,
    );
    expect(bucketed).toBe(stats.lineCount);
  });

  it('distributes accepted suggestions by rank, keeping unranked ones visible', () => {
    const stats = computeMatchingStats(1, [
      line({ boundVia: 'suggested', boundRank: 2 }),
      line({ boundVia: 'suggested', boundRank: 1 }),
      line({ boundVia: 'suggested', boundRank: 2 }),
      line({ boundVia: 'suggested', boundRank: null }),
      // A rank only means something for an accepted suggestion.
      line({ boundVia: 'manual', boundRank: 3 }),
    ]);

    expect(stats.suggested).toEqual({
      lineCount: 4,
      ranks: [
        { rank: 1, lineCount: 1 },
        { rank: 2, lineCount: 2 },
      ],
      unrankedLineCount: 1,
    });
    const ranked = stats.suggested.ranks.reduce(
      (total, rank) => total + rank.lineCount,
      stats.suggested.unrankedLineCount,
    );
    expect(ranked).toBe(stats.suggested.lineCount);
  });
});
