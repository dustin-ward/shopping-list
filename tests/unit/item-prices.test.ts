import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/lib/client/api';
import { formatMoney } from '../../src/lib/client/money';
import {
  fetchItemPrices,
  lastPaidWhen,
  perUnitLabel,
  pricesErrorMessage,
  pricesNudge,
  sparkline,
  trendReading,
} from '../../src/lib/client/item-prices';
import type {
  ItemPriceFamily,
  ItemPricePoint,
  ItemPrices,
  ItemStorePrices,
} from '../../src/lib/shared/schemas';

/**
 * The price sheet's own arithmetic and words (ticket 21): where a sparkline
 * draws, how old a price is in household terms, and which store's last paid
 * amount the add-form nudge names. The server's aggregates are ticket 20's;
 * this file never re-derives them.
 */

function point(
  overrides: Partial<ItemPricePoint> & { normalizedUnitPriceMinor: number },
): ItemPricePoint {
  return {
    receiptId: 'receipt-1',
    lineId: 'line-1',
    receiptCreatedAt: '2026-10-01T12:00:00.000Z',
    printedText: 'CUCUMBERS 2 @ 1.50',
    quantityReal: 2,
    quantityUnit: 'ea',
    totalPriceMinor: 300,
    ...overrides,
  };
}

function family(
  history: ItemPricePoint[],
  overrides: Partial<ItemPriceFamily> = {},
): ItemPriceFamily {
  const prices = history.map((entry) => entry.normalizedUnitPriceMinor);
  return {
    family: 'count',
    unit: 'ea',
    lineCount: history.length,
    lastUnitPriceMinor: prices.at(-1) ?? 0,
    minUnitPriceMinor: Math.min(...prices),
    maxUnitPriceMinor: Math.max(...prices),
    trend: 'unknown',
    history,
    ...overrides,
  };
}

function store(overrides: Partial<ItemStorePrices> = {}): ItemStorePrices {
  return {
    storeGroupId: 'store-1',
    storeName: 'Hen House',
    lineCount: 1,
    spendMinor: 349,
    lastPaidMinor: 349,
    lastPaidAt: new Date(2026, 9, 15, 12, 0).toISOString(),
    lastReceiptId: 'receipt-1',
    families: [],
    ...overrides,
  };
}

function prices(overrides: Partial<ItemPrices> = {}): ItemPrices {
  return {
    catalogItemId: 'item-1',
    itemName: 'Milk',
    currency: 'USD',
    receiptCount: 1,
    lineCount: 1,
    spendMinor: 349,
    stores: [store()],
    ...overrides,
  };
}

describe('sparkline — where the unit prices draw', () => {
  function sample(value: number, at: string) {
    return { value, at };
  }

  it('spreads two different prices from padding to padding, low to high', () => {
    expect(
      sparkline(
        [
          sample(100, '2026-10-01T12:00:00.000Z'),
          sample(200, '2026-10-15T12:00:00.000Z'),
        ],
        100,
        20,
        2,
      ),
    ).toEqual({
      points: '2.0,18.0 98.0,2.0',
      last: { x: 98, y: 2 },
    });
  });

  it('spaces points by recorded time, not by their order in the list', () => {
    // The second receipt is three weeks after the first but the third is one
    // day later, so the last two sit close together on the right.
    expect(
      sparkline(
        [
          sample(100, '2026-09-01T12:00:00.000Z'),
          sample(150, '2026-09-22T12:00:00.000Z'),
          sample(200, '2026-09-23T12:00:00.000Z'),
        ],
        100,
        20,
        2,
      ).points,
    ).toBe('2.0,18.0 93.6,10.0 98.0,2.0');
  });

  it('keeps a flat series on the middle line', () => {
    expect(
      sparkline(
        [
          sample(5, '2026-10-01T12:00:00.000Z'),
          sample(5, '2026-10-08T12:00:00.000Z'),
          sample(5, '2026-10-15T12:00:00.000Z'),
        ],
        100,
        20,
        2,
      ),
    ).toEqual({
      points: '2.0,10.0 50.0,10.0 98.0,10.0',
      last: { x: 98, y: 10 },
    });
  });

  it('stacks variants bought on the same trip at one instant', () => {
    expect(
      sparkline(
        [
          sample(100, '2026-10-15T12:00:00.000Z'),
          sample(200, '2026-10-15T12:00:00.000Z'),
        ],
        100,
        20,
        2,
      ).points,
    ).toBe('50.0,18.0 50.0,2.0');
  });

  it('centres a single recorded price', () => {
    expect(
      sparkline([sample(349, '2026-10-15T12:00:00.000Z')], 100, 20, 2),
    ).toEqual({
      points: '50.0,10.0',
      last: { x: 50, y: 10 },
    });
  });

  it('has nothing to draw for an empty series', () => {
    expect(sparkline([])).toEqual({ points: '', last: null });
  });
});

describe('trendReading — the direction, in words', () => {
  it('names every trend the server can answer', () => {
    expect(trendReading('up')).toEqual({
      arrow: '↑',
      label: 'Up from last time',
    });
    expect(trendReading('down')).toEqual({
      arrow: '↓',
      label: 'Down from last time',
    });
    expect(trendReading('flat')).toEqual({
      arrow: '→',
      label: 'No change from last time',
    });
    expect(trendReading('unknown')).toEqual({
      arrow: '·',
      label: 'Not enough history to trend',
    });
  });
});

describe('perUnitLabel — never a bare number', () => {
  it('names the base unit the price was normalized to', () => {
    expect(perUnitLabel('kg')).toBe('per kg');
    expect(perUnitLabel('l')).toBe('per l');
    expect(perUnitLabel('ea')).toBe('per ea');
  });
});

describe('lastPaidWhen — a price in household terms', () => {
  const now = new Date(2026, 9, 22, 9, 30);

  it('reads today and yesterday without arithmetic', () => {
    expect(lastPaidWhen(new Date(2026, 9, 22, 7, 0).toISOString(), now)).toBe(
      'today',
    );
    expect(lastPaidWhen(new Date(2026, 9, 21, 18, 0).toISOString(), now)).toBe(
      'yesterday',
    );
  });

  it('counts the days of the past week', () => {
    expect(lastPaidWhen(new Date(2026, 9, 19, 12, 0).toISOString(), now)).toBe(
      '3 days ago',
    );
  });

  it('calls the previous week "last week"', () => {
    expect(lastPaidWhen(new Date(2026, 9, 10, 12, 0).toISOString(), now)).toBe(
      'last week',
    );
  });

  it('counts older weeks and months', () => {
    expect(lastPaidWhen(new Date(2026, 8, 29, 12, 0).toISOString(), now)).toBe(
      '3 weeks ago',
    );
    expect(lastPaidWhen(new Date(2026, 8, 1, 12, 0).toISOString(), now)).toBe(
      'last month',
    );
  });

  it('names the date of an older price', () => {
    expect(lastPaidWhen(new Date(2026, 5, 3, 12, 0).toISOString(), now)).toBe(
      'on Jun 3',
    );
    expect(lastPaidWhen(new Date(2025, 5, 3, 12, 0).toISOString(), now)).toBe(
      'on Jun 3, 2025',
    );
  });

  it('treats a future clock as today rather than inventing a lead time', () => {
    expect(lastPaidWhen(new Date(2026, 9, 25, 12, 0).toISOString(), now)).toBe(
      'today',
    );
  });
});

describe('pricesNudge — the add-form sentence', () => {
  const now = new Date(2026, 9, 22, 9, 30);

  it('names the most recent price, when it was paid, and where', () => {
    expect(pricesNudge(prices(), now)).toBe(
      `${formatMoney(349, 'USD')} last week at Hen House`,
    );
  });

  it('uses the newest store that actually recorded an amount', () => {
    const body = prices({
      stores: [
        store({
          storeGroupId: 'store-2',
          storeName: 'Corner Market',
          lastPaidMinor: null,
          lastPaidAt: new Date(2026, 9, 20, 12, 0).toISOString(),
        }),
        store(),
      ],
    });

    expect(pricesNudge(body, now)).toBe(
      `${formatMoney(349, 'USD')} last week at Hen House`,
    );
  });

  it('stays quiet when no committed line recorded an amount', () => {
    expect(
      pricesNudge(prices({ stores: [store({ lastPaidMinor: null })] }), now),
    ).toBeNull();
  });

  it('stays quiet for an item with no committed receipts', () => {
    expect(pricesNudge(prices({ stores: [] }), now)).toBeNull();
  });
});

describe('pricesErrorMessage — every refusal in one sentence', () => {
  it('explains a vanished item', () => {
    expect(
      pricesErrorMessage(new ApiError(404, 'NOT_FOUND', 'Item not found.')),
    ).toContain('no longer in the item list');
  });

  it('keeps the server’s own message for other refusals', () => {
    expect(
      pricesErrorMessage(new ApiError(500, 'INTERNAL', 'Prices are down.')),
    ).toBe('Prices are down.');
  });

  it('covers a network failure', () => {
    expect(pricesErrorMessage(new Error('offline'))).toBe(
      'Prices are unavailable. Try again.',
    );
  });
});

describe('fetchItemPrices — the read', () => {
  it('asks the item’s prices endpoint', async () => {
    const requested: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response(
        JSON.stringify(
          prices({
            catalogItemId: 'item-42',
            stores: [
              store({
                families: [family([point({ normalizedUnitPriceMinor: 150 })])],
              }),
            ],
          }),
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      const body = await fetchItemPrices('item-42');
      expect(requested).toEqual(['/api/items/item-42/prices']);
      expect(body.catalogItemId).toBe('item-42');
    } finally {
      globalThis.fetch = original;
    }
  });
});
