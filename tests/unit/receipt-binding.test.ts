import { describe, expect, it } from 'vitest';
import {
  bindItemEdit,
  draftItemEdit,
  filterItems,
  itemDraftName,
  itemPickerPrefill,
  releaseEdit,
  storePrefill,
  suggestionEdit,
  suggestionRank,
  type CatalogItemOption,
} from '../../src/lib/client/receipt-binding';
import type {
  ReceiptDetailLine,
  ReceiptSuggestion,
} from '../../src/lib/shared/schemas';

/**
 * The binding layer's rules, as data: what a chip tap, a search pick and a
 * draft mean. Expected values are the schema's own definitions — a rank is the
 * candidate's 1-based position, provenance names the human path, a draft keeps
 * no item — so the tests cannot pass by restating the implementation.
 */

const ITEM_ID = '00000000-0000-4000-8000-0000000000aa';
const OTHER_ITEM_ID = '00000000-0000-4000-8000-0000000000bb';

function suggestion(
  overrides: Partial<ReceiptSuggestion> = {},
): ReceiptSuggestion {
  return {
    catalogItemId: ITEM_ID,
    name: 'Milk',
    tier: 2,
    score: 0.92,
    sameStore: false,
    ...overrides,
  };
}

function line(overrides: Partial<ReceiptDetailLine> = {}): ReceiptDetailLine {
  return {
    id: '00000000-0000-4000-8000-0000000000cc',
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

describe('suggestionRank', () => {
  it('is the candidate’s 1-based position in the payload order', () => {
    const withChips = line({
      suggestions: [
        suggestion(),
        suggestion({ catalogItemId: OTHER_ITEM_ID, name: 'Milk 2%' }),
      ],
    });

    expect(suggestionRank(withChips, ITEM_ID)).toBe(1);
    expect(suggestionRank(withChips, OTHER_ITEM_ID)).toBe(2);
  });

  it('is null for a candidate this line does not carry', () => {
    expect(
      suggestionRank(line({ suggestions: [suggestion()] }), 'ignored'),
    ).toBeNull();
    expect(suggestionRank(line(), ITEM_ID)).toBeNull();
  });
});

describe('suggestionEdit', () => {
  it('binds to the accepted candidate with its rank as provenance', () => {
    const withChips = line({
      suggestions: [
        suggestion({ catalogItemId: OTHER_ITEM_ID, name: 'Milk 2%' }),
        suggestion(),
      ],
    });

    expect(suggestionEdit(withChips, suggestion())).toEqual({
      reviewState: 'bound',
      catalogItemId: ITEM_ID,
      boundVia: 'suggested',
      boundRank: 2,
    });
  });

  it('releases the line when the chip it already sits on is tapped again', () => {
    const bound = line({
      reviewState: 'bound',
      catalogItemId: ITEM_ID,
      boundVia: 'auto',
      suggestions: [suggestion({ tier: 1, score: 1 })],
    });

    expect(suggestionEdit(bound, suggestion({ tier: 1, score: 1 }))).toEqual(
      releaseEdit(),
    );
    expect(releaseEdit()).toEqual({ reviewState: 'unreviewed' });
  });

  it('refuses a candidate the line does not carry', () => {
    expect(suggestionEdit(line(), suggestion())).toBeNull();
  });
});

describe('bindItemEdit', () => {
  it('records the reviewer as the source of a search pick, with no rank', () => {
    // The picker is tier 3 ("search + create"), so even a pick that matches a
    // suggestion stays a find of the reviewer's own.
    expect(bindItemEdit(ITEM_ID)).toEqual({
      reviewState: 'bound',
      catalogItemId: ITEM_ID,
      boundVia: 'manual',
      boundRank: null,
    });
  });
});

describe('draftItemEdit', () => {
  it('drafts the parser’s name without touching an item', () => {
    expect(draftItemEdit(line())).toEqual({
      patch: { reviewState: 'new' },
      name: 'MILK 2% 1L',
    });
  });

  it('falls back to the printed text when the parser named nothing', () => {
    expect(itemDraftName(line({ parsedName: null }))).toBe('MILK 2% 1L');
    expect(itemDraftName(line({ parsedName: '  ' }))).toBe('MILK 2% 1L');
  });
});

describe('itemPickerPrefill', () => {
  it('prefigures the top candidate on a line with no decision', () => {
    // The plan's tier 2: "top candidate is prefilled but never auto-bound".
    const withChips = line({
      suggestions: [
        suggestion(),
        suggestion({ catalogItemId: OTHER_ITEM_ID, name: 'Milk 2%' }),
      ],
    });

    expect(itemPickerPrefill(withChips)).toBe('Milk');
  });

  it('prefigures nothing without candidates, or once the line is decided', () => {
    expect(itemPickerPrefill(line())).toBe('');

    const withChips = line({
      reviewState: 'skipped',
      suggestions: [suggestion()],
    });
    expect(itemPickerPrefill(withChips)).toBe('');
  });
});

describe('filterItems', () => {
  const items: CatalogItemOption[] = [
    { id: ITEM_ID, name: 'Milk' },
    { id: OTHER_ITEM_ID, name: 'Milk 2%' },
    { id: '00000000-0000-4000-8000-0000000000dd', name: 'Sourdough Bread' },
  ];

  it('matches on the normalized name and ignores case and spacing', () => {
    expect(filterItems(items, '  milk ').map((item) => item.name)).toEqual([
      'Milk',
      'Milk 2%',
    ]);
    expect(filterItems(items, 'bread').map((item) => item.name)).toEqual([
      'Sourdough Bread',
    ]);
  });

  it('offers nothing for an empty search or a phrase no item carries', () => {
    expect(filterItems(items, '')).toEqual([]);
    expect(filterItems(items, 'yogurt')).toEqual([]);
  });
});

describe('storePrefill', () => {
  const cornerMarket = {
    id: 'store-1',
    name: 'Corner Market',
    kind: 'store' as const,
  };
  const market = { id: 'store-2', name: 'Market', kind: 'store' as const };

  it('offers the store whose name the receipt text carries', () => {
    const lines = [{ rawText: 'CORNER MARKET' }, { rawText: 'MILK 2% 1L' }];

    expect(storePrefill(lines, [market, cornerMarket])).toEqual(cornerMarket);
  });

  it('prefers the longest name when two stores are both printed', () => {
    expect(
      storePrefill([{ rawText: 'CORNER MARKET' }], [cornerMarket, market]),
    ).toEqual(cornerMarket);
  });

  it('does not match a name inside another word', () => {
    expect(
      storePrefill(
        [{ rawText: 'ORIGAMI PAPER' }],
        [{ id: 'x', name: 'IGA', kind: 'store' }],
      ),
    ).toBeNull();
  });

  it('offers nothing when the receipt names no store, or no store is known', () => {
    expect(
      storePrefill([{ rawText: 'MILK 2% 1L' }], [cornerMarket]),
    ).toBeNull();
    expect(storePrefill([], [cornerMarket])).toBeNull();
    expect(storePrefill([{ rawText: 'CORNER MARKET' }], [])).toBeNull();
  });
});
