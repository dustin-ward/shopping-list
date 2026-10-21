import { describe, expect, it } from 'vitest';
import {
  MATCHING_STATS_EMPTY,
  matchingRankLabel,
  matchingReconciliation,
  matchingSharePercent,
  matchingSourceLabel,
  matchingSourceShortLabel,
  matchingStatsHeadline,
  suggestedRankSummary,
  unrankedSuggestedNote,
} from '../../src/lib/client/receipt-matching-stats';
import type { MatchingStats } from '../../src/lib/shared/schemas';

/**
 * The matching-stats surface's client rules: the words each bucket goes by, the
 * shares those counts imply, and the sentences that make the reconciliation and
 * the empty state readable without a browser.
 */

function stats(overrides: Partial<MatchingStats> = {}): MatchingStats {
  return {
    committedReceiptCount: 2,
    lineCount: 12,
    noBindingLineCount: 2,
    sources: [
      { source: 'auto', lineCount: 4 },
      { source: 'suggested', lineCount: 3 },
      { source: 'manual', lineCount: 2 },
      { source: 'created', lineCount: 1 },
    ],
    suggested: {
      lineCount: 3,
      ranks: [
        { rank: 1, lineCount: 2 },
        { rank: 3, lineCount: 1 },
      ],
      unrankedLineCount: 0,
    },
    ...overrides,
  };
}

describe('matching stats client copy', () => {
  it('names every provenance bucket and its short form', () => {
    expect(matchingSourceLabel('auto')).toBe('Automatic (tier 1)');
    expect(matchingSourceLabel('suggested')).toBe(
      'Accepted suggestion (tier 2)',
    );
    expect(matchingSourceLabel('manual')).toBe('Chosen manually');
    expect(matchingSourceLabel('created')).toBe('Item created in review');
    expect(matchingSourceShortLabel('auto')).toBe('automatic');
    expect(matchingSourceShortLabel('suggested')).toBe('suggested');
    expect(matchingSourceShortLabel('manual')).toBe('manual');
    expect(matchingSourceShortLabel('created')).toBe('created');
  });

  it('turns counts into whole percentages, and zero total into zero', () => {
    expect(matchingSharePercent(4, 12)).toBe(33);
    expect(matchingSharePercent(12, 12)).toBe(100);
    expect(matchingSharePercent(1, 3)).toBe(33);
    expect(matchingSharePercent(0, 0)).toBe(0);
  });

  it('headlines the committed corpus, and says when there is none', () => {
    expect(matchingStatsHeadline(stats())).toBe(
      '2 committed receipts · 12 item lines',
    );
    expect(
      matchingStatsHeadline(stats({ committedReceiptCount: 1, lineCount: 1 })),
    ).toBe('1 committed receipt · 1 item line');
    expect(
      matchingStatsHeadline(stats({ committedReceiptCount: 0, lineCount: 0 })),
    ).toBe('No receipts committed yet.');
    expect(MATCHING_STATS_EMPTY).toContain('No receipts committed yet');
  });

  it('reconciles the buckets with the committed lines in one sentence', () => {
    expect(matchingReconciliation(stats())).toBe(
      '12 committed item lines: 4 automatic, 3 suggested, 2 manual, 1 created, 2 unknown or skipped.',
    );
    expect(
      matchingReconciliation(
        stats({ lineCount: 6, noBindingLineCount: 0, sources: [] }),
      ),
    ).toBe(
      '6 committed item lines: 0 automatic, 0 suggested, 0 manual, 0 created.',
    );
  });

  it('summarises accepted suggestions by rank, including unranked accepts', () => {
    expect(suggestedRankSummary(stats())).toBe(
      '3 accepted suggestions by rank.',
    );
    expect(
      suggestedRankSummary(
        stats({
          suggested: { lineCount: 1, ranks: [], unrankedLineCount: 1 },
        }),
      ),
    ).toBe('1 accepted suggestion by rank.');
    expect(
      suggestedRankSummary(
        stats({
          suggested: { lineCount: 0, ranks: [], unrankedLineCount: 0 },
        }),
      ),
    ).toBe('No accepted suggestions yet.');
    expect(matchingRankLabel(1)).toBe('Rank 1');
    expect(
      unrankedSuggestedNote(
        stats({
          suggested: { lineCount: 2, ranks: [], unrankedLineCount: 2 },
        }),
      ),
    ).toBe('2 accepted suggestions have no rank recorded.');
    expect(
      unrankedSuggestedNote(
        stats({
          suggested: { lineCount: 1, ranks: [], unrankedLineCount: 1 },
        }),
      ),
    ).toBe('1 accepted suggestion has no rank recorded.');
    expect(unrankedSuggestedNote(stats())).toBe('');
  });
});
