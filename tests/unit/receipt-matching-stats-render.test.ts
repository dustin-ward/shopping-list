import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import ReceiptMatchingStats from '../../src/lib/components/receipts/ReceiptMatchingStats.svelte';
import type { MatchingStats } from '../../src/lib/shared/schemas';

/**
 * The matching-stats surface as it is read: the share of committed item lines by
 * binding source, the reconciliation that proves the buckets add up, the
 * accepted-suggestion ranks, and the empty state before anything is committed.
 */

function readable(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/gu, '').replace(/ svelte-\w+/gu, '');
}

function stats(overrides: Partial<MatchingStats> = {}): MatchingStats {
  return {
    committedReceiptCount: 2,
    lineCount: 10,
    noBindingLineCount: 2,
    sources: [
      { source: 'auto', lineCount: 4 },
      { source: 'suggested', lineCount: 3 },
      { source: 'manual', lineCount: 1 },
      { source: 'created', lineCount: 0 },
    ],
    suggested: {
      lineCount: 3,
      ranks: [
        { rank: 1, lineCount: 2 },
        { rank: 2, lineCount: 1 },
      ],
      unrankedLineCount: 0,
    },
    ...overrides,
  };
}

function renderStats(body: MatchingStats = stats()): string {
  return readable(
    render(ReceiptMatchingStats, { props: { stats: body } }).body,
  );
}

describe('ReceiptMatchingStats', () => {
  it('shows the committed corpus and every provenance bucket with its share', () => {
    const body = renderStats();

    expect(body).toContain('2 committed receipts · 10 item lines');
    for (const label of [
      'Automatic (tier 1)',
      'Accepted suggestion (tier 2)',
      'Chosen manually',
      'Item created in review',
    ]) {
      expect(body).toContain(label);
    }
    expect(body).toMatch(
      /data-source="auto"[\s\S]*?stats-source-count[^>]*>4<[\s\S]*?40%/u,
    );
    expect(body).toMatch(
      /data-source="suggested"[\s\S]*?stats-source-count[^>]*>3<[\s\S]*?30%/u,
    );
    expect(body).toContain(
      '10 committed item lines: 4 automatic, 3 suggested, 1 manual, 0 created, 2 unknown or skipped.',
    );
  });

  it('shows the no-binding residual only when committed lines lack one', () => {
    expect(renderStats()).toContain('Unknown or skipped');
    expect(
      renderStats(
        stats({
          lineCount: 8,
          noBindingLineCount: 0,
          sources: [
            { source: 'auto', lineCount: 4 },
            { source: 'suggested', lineCount: 3 },
            { source: 'manual', lineCount: 1 },
            { source: 'created', lineCount: 0 },
          ],
        }),
      ),
    ).not.toContain('Unknown or skipped');
  });

  it('lists accepted suggestions by rank, and unranked accepts', () => {
    const body = renderStats();

    expect(body).toContain('Accepted suggestions by rank');
    expect(body).toContain('3 accepted suggestions by rank.');
    expect(body).toMatch(/data-rank="1"[\s\S]*?Rank 1[\s\S]*?67%/u);
    expect(body).toMatch(/data-rank="2"[\s\S]*?Rank 2[\s\S]*?33%/u);
    expect(body).not.toContain('no rank recorded');

    const unranked = renderStats(
      stats({
        suggested: {
          lineCount: 2,
          ranks: [{ rank: 1, lineCount: 1 }],
          unrankedLineCount: 1,
        },
      }),
    );
    expect(unranked).toContain('1 accepted suggestion has no rank recorded.');
  });

  it('says when no suggestion has been accepted', () => {
    const body = renderStats(
      stats({
        suggested: { lineCount: 0, ranks: [], unrankedLineCount: 0 },
      }),
    );

    expect(body).toContain('No accepted suggestions yet.');
    expect(body).not.toContain('data-rank=');
  });

  it('shows the empty state before any receipt is committed', () => {
    const body = renderStats(
      stats({
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
      }),
    );

    expect(body).toContain('No receipts committed yet.');
    expect(body.match(/No receipts committed yet\./gu)).toHaveLength(1);
    expect(body).not.toContain('Line provenance');
    expect(body).not.toContain('Accepted suggestions by rank');
  });
});
