import { describe, expect, it } from 'vitest';
import {
  REVIEW_STATE_LABELS,
  nextReviewState,
  reviewStateKeepsBinding,
} from '../../src/lib/shared/receipt-review';
import { lineEditPatch } from '../../src/lib/client/receipt-review';
import type { ReceiptDetailLine } from '../../src/lib/shared/schemas';

/** A line as the detail API returns it, before any review edit. */
function line(overrides: Partial<ReceiptDetailLine> = {}): ReceiptDetailLine {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    lineIndex: 4,
    rawText: 'MILK 2% 1L',
    parsedName: 'MILK 2% 1L',
    quantityReal: null,
    quantityText: null,
    quantityUnit: null,
    unitPriceMinor: null,
    totalPriceMinor: 349,
    isItemChunk: true,
    confidence: 0.96,
    catalogItemId: null,
    reviewState: 'unreviewed',
    boundVia: null,
    boundRank: null,
    suggestions: [],
    ...overrides,
  };
}

describe('nextReviewState', () => {
  it('moves an unreviewed line into the pressed state', () => {
    expect(nextReviewState('unreviewed', 'unknown')).toBe('unknown');
    expect(nextReviewState('unreviewed', 'skipped')).toBe('skipped');
  });

  it('switches directly between the two states', () => {
    expect(nextReviewState('unknown', 'skipped')).toBe('skipped');
    expect(nextReviewState('skipped', 'unknown')).toBe('unknown');
  });

  it('presses the same state again back to unreviewed', () => {
    expect(nextReviewState('unknown', 'unknown')).toBe('unreviewed');
    expect(nextReviewState('skipped', 'skipped')).toBe('unreviewed');
  });

  it('releases a bound line back to unreviewed when it is marked unknown', () => {
    expect(nextReviewState('bound', 'unknown')).toBe('unknown');
    expect(nextReviewState('new', 'skipped')).toBe('skipped');
  });
});

describe('reviewStateKeepsBinding', () => {
  it('keeps a catalog item only on a bound line', () => {
    expect(reviewStateKeepsBinding('bound')).toBe(true);
    for (const state of ['unreviewed', 'new', 'unknown', 'skipped'] as const) {
      expect(reviewStateKeepsBinding(state)).toBe(false);
    }
  });
});

describe('REVIEW_STATE_LABELS', () => {
  it('names every state in the reviewer’s words', () => {
    expect(REVIEW_STATE_LABELS).toEqual({
      unreviewed: 'Unreviewed',
      bound: 'Bound',
      new: 'New item',
      unknown: 'Unknown',
      skipped: 'Skipped',
    });
  });
});

describe('lineEditPatch', () => {
  const typed = {
    rawText: 'MILK 2% 1L',
    quantityReal: '',
    quantityText: '',
    quantityUnit: '',
    unitPriceMinor: '',
    totalPriceMinor: '3.49',
  };

  it('reports no change when the form still holds the stored values', () => {
    const result = lineEditPatch(typed, line());

    expect(result).toEqual({ ok: true, patch: null });
  });

  it('reads money into minor units and trims text', () => {
    const result = lineEditPatch(
      {
        ...typed,
        rawText: '  MILK 2% 1 L  ',
        unitPriceMinor: '1.50',
        totalPriceMinor: '$3.99',
      },
      line(),
    );

    expect(result).toEqual({
      ok: true,
      patch: {
        rawText: 'MILK 2% 1 L',
        unitPriceMinor: 150,
        totalPriceMinor: 399,
      },
    });
  });

  it('clears a field that was emptied', () => {
    const result = lineEditPatch(
      { ...typed, quantityText: '', totalPriceMinor: '' },
      line({ quantityText: '2 @ 1.50', totalPriceMinor: 349 }),
    );

    expect(result).toEqual({
      ok: true,
      patch: { quantityText: null, totalPriceMinor: null },
    });
  });

  it('reads a quantity and a canonical unit', () => {
    const result = lineEditPatch(
      { ...typed, quantityReal: '2.15', quantityUnit: 'lb' },
      line(),
    );

    expect(result).toEqual({
      ok: true,
      patch: { quantityReal: 2.15, quantityUnit: 'lb' },
    });
  });

  it('refuses an empty printed text', () => {
    const result = lineEditPatch({ ...typed, rawText: '   ' }, line());

    expect(result).toMatchObject({ ok: false });
  });

  it('refuses a quantity that is not a positive number', () => {
    for (const quantityReal of ['0', '-1', 'two', '1,5']) {
      const result = lineEditPatch({ ...typed, quantityReal }, line());
      expect(result, quantityReal).toMatchObject({ ok: false });
    }
  });

  it('refuses a price that is not an amount', () => {
    for (const price of ['3.499', '3.49.9', 'free', '1e3']) {
      const result = lineEditPatch(
        { ...typed, totalPriceMinor: price },
        line(),
      );
      expect(result, price).toMatchObject({ ok: false });
    }
  });

  it('reads a negative amount, the way a coupon line prints it', () => {
    const result = lineEditPatch(
      { ...typed, totalPriceMinor: '-1.50' },
      line({ totalPriceMinor: -150 }),
    );

    expect(result).toEqual({ ok: true, patch: null });
  });
});
