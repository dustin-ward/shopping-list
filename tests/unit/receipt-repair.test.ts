import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/lib/client/api';
import {
  repairBindPatch,
  repairErrorMessage,
  repairReceiptInput,
  repairStatePatch,
  repairSuggestionPatch,
} from '../../src/lib/client/receipt-repair';
import type { ReceiptDetailLine } from '../../src/lib/shared/schemas';

/**
 * What a tap in repair mode means, before any request is made: the correction a
 * state control, a suggestion chip or a pick from the item search asks for — and
 * the taps that are not corrections at all (ticket 16).
 */

const LINE_ID = '00000000-0000-4000-8000-0000000000cc';
const OLD_ITEM = '00000000-0000-4000-8000-0000000000aa';
const NEW_ITEM = '00000000-0000-4000-8000-0000000000bb';

function line(overrides: Partial<ReceiptDetailLine> = {}): ReceiptDetailLine {
  return {
    id: LINE_ID,
    lineIndex: 0,
    rawText: 'MILK 2% 1L',
    parsedName: 'MILK 2% 1L',
    quantityReal: null,
    quantityText: null,
    quantityUnit: null,
    unitPriceMinor: null,
    totalPriceMinor: 349,
    isItemChunk: true,
    confidence: 0.96,
    catalogItemId: OLD_ITEM,
    reviewState: 'bound',
    boundVia: 'manual',
    boundRank: null,
    suggestions: [],
    ...overrides,
  };
}

describe('repairStatePatch', () => {
  it('marks a bound line unknown, releasing its binding', () => {
    expect(repairStatePatch(line(), 'unknown')).toEqual({
      reviewState: 'unknown',
    });
  });

  it('has nothing to correct when the line already sits in that state', () => {
    expect(
      repairStatePatch(line({ reviewState: 'unknown' }), 'unknown'),
    ).toBeNull();
    expect(
      repairStatePatch(line({ reviewState: 'skipped' }), 'skipped'),
    ).toBeNull();
  });

  it('switches between the two unidentified states', () => {
    expect(
      repairStatePatch(
        line({ reviewState: 'unknown', catalogItemId: null }),
        'skipped',
      ),
    ).toEqual({ reviewState: 'skipped' });
  });
});

describe('repairSuggestionPatch', () => {
  const suggestion = {
    catalogItemId: NEW_ITEM,
    name: 'Sourdough Bread',
    tier: 2 as const,
    score: 0.9,
    sameStore: false,
  };

  it('accepts a candidate with the rank the reviewer tapped', () => {
    const withChip = line({
      suggestions: [
        {
          ...suggestion,
          catalogItemId: '00000000-0000-4000-8000-0000000000dd',
        },
        suggestion,
      ],
    });

    expect(repairSuggestionPatch(withChip, suggestion)).toEqual({
      reviewState: 'bound',
      catalogItemId: NEW_ITEM,
      boundVia: 'suggested',
      boundRank: 2,
    });
  });

  it('refuses the chip the line already sits on: its binding is not a correction', () => {
    const bound = line({
      catalogItemId: NEW_ITEM,
      suggestions: [{ ...suggestion, tier: 1 as const, score: 1 }],
    });

    expect(repairSuggestionPatch(bound, suggestion)).toBeNull();
  });
});

describe('repairBindPatch', () => {
  it('binds the line to the item the reviewer picked, by hand', () => {
    expect(repairBindPatch(line(), NEW_ITEM)).toEqual({
      reviewState: 'bound',
      catalogItemId: NEW_ITEM,
      boundVia: 'manual',
      boundRank: null,
    });
  });

  it('has nothing to correct when the pick is the line’s own item', () => {
    expect(repairBindPatch(line(), OLD_ITEM)).toBeNull();
  });
});

describe('repairReceiptInput', () => {
  it('names the line and carries the updatedAt the editor last saw', () => {
    const detail = {
      id: '00000000-0000-4000-8000-0000000000ee',
      updatedAt: '2026-10-17T12:06:00.000Z',
    };

    expect(
      repairReceiptInput(detail, LINE_ID, { reviewState: 'unknown' }),
    ).toEqual({
      expectedUpdatedAt: '2026-10-17T12:06:00.000Z',
      lines: [{ id: LINE_ID, reviewState: 'unknown' }],
    });
  });
});

describe('repairErrorMessage', () => {
  it('says which refusal a repair can meet, in the reviewer’s words', () => {
    expect(
      repairErrorMessage(
        new ApiError(409, 'RECEIPT_NOT_COMMITTED', 'Only a committed receipt…'),
      ),
    ).toBe('Only a committed receipt can be repaired.');
    expect(
      repairErrorMessage(new ApiError(409, 'RECEIPT_CHANGED', 'This receipt…')),
    ).toBe(
      'This receipt changed on another device — the latest version is shown.',
    );
    expect(
      repairErrorMessage(
        new ApiError(400, 'INVALID_LINE', 'Only an item line…'),
      ),
    ).toBe('Only an item line on this receipt can be repaired.');
    expect(
      repairErrorMessage(new ApiError(404, 'NOT_FOUND', 'Receipt not found.')),
    ).toBe('That receipt no longer exists.');
  });

  it('falls back to the server’s message, then to a plain sentence', () => {
    expect(
      repairErrorMessage(new ApiError(400, 'INVALID_ITEM', 'Choose an item.')),
    ).toBe('Choose an item.');
    expect(repairErrorMessage(new Error('offline'))).toBe(
      'The repair could not be saved. Try again.',
    );
  });
});
