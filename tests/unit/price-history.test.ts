import { describe, expect, it } from 'vitest';
import {
  lineUnitPrice,
  normalizeUnitPrice,
  summarizeItemPrices,
  type PriceHistoryRow,
} from '../../src/lib/server/receipts/price-history';

/**
 * Price history's rules, pure and database-free (ticket 20): a printed unit
 * price becomes one comparable number per measurement family (mass → kg,
 * volume → l, count → ea), and a single chronological pass turns committed
 * lines into per-store, per-family last/min/max/trend. A line whose unit cannot
 * be normalized never reaches a per-unit aggregate, but its spend still counts.
 */

type RowOverrides = Partial<PriceHistoryRow>;

let lineNumber = 0;

function row(overrides: RowOverrides = {}): PriceHistoryRow {
  lineNumber += 1;
  return {
    storeGroupId: 'store-1',
    storeName: 'Corner Market',
    receiptId: `receipt-${lineNumber}`,
    receiptCreatedAt: '2026-10-01T12:00:00.000Z',
    lineId: `line-${lineNumber}`,
    printedText: 'MILK',
    totalPriceMinor: 499,
    unitPriceMinor: 499,
    quantityReal: 1,
    quantityUnit: 'ea',
    ...overrides,
  };
}

describe('lineUnitPrice', () => {
  it('uses the printed unit price when the line has one', () => {
    expect(
      lineUnitPrice({
        unitPriceMinor: 499,
        totalPriceMinor: 998,
        quantityReal: 2,
      }),
    ).toBe(499);
  });

  it('derives the unit price from a total and quantity when needed', () => {
    expect(
      lineUnitPrice({
        unitPriceMinor: null,
        totalPriceMinor: 600,
        quantityReal: 2,
      }),
    ).toBe(300);
  });

  it('refuses to invent a unit price without a quantity', () => {
    expect(
      lineUnitPrice({
        unitPriceMinor: null,
        totalPriceMinor: 600,
        quantityReal: null,
      }),
    ).toBeNull();
    expect(
      lineUnitPrice({
        unitPriceMinor: null,
        totalPriceMinor: 600,
        quantityReal: 0,
      }),
    ).toBeNull();
  });
});

describe('normalizeUnitPrice', () => {
  it('compares mass in kilograms', () => {
    expect(normalizeUnitPrice(499, 'lb')).toEqual({
      family: 'mass',
      unit: 'kg',
      priceMinor: 1100,
    });
    expect(normalizeUnitPrice(100, 'oz')).toEqual({
      family: 'mass',
      unit: 'kg',
      priceMinor: 3527,
    });
    expect(normalizeUnitPrice(2, 'g')).toEqual({
      family: 'mass',
      unit: 'kg',
      priceMinor: 2000,
    });
    expect(normalizeUnitPrice(499, 'kg')).toEqual({
      family: 'mass',
      unit: 'kg',
      priceMinor: 499,
    });
  });

  it('compares volume in litres', () => {
    expect(normalizeUnitPrice(129, 'l')).toEqual({
      family: 'volume',
      unit: 'l',
      priceMinor: 129,
    });
    expect(normalizeUnitPrice(1, 'ml')).toEqual({
      family: 'volume',
      unit: 'l',
      priceMinor: 1000,
    });
  });

  it('compares counts as each', () => {
    expect(normalizeUnitPrice(150, 'ea')).toEqual({
      family: 'count',
      unit: 'ea',
      priceMinor: 150,
    });
  });

  it('has no answer for a line with no canonical unit', () => {
    expect(normalizeUnitPrice(150, null)).toBeNull();
  });

  it('keeps a free line as a real zero, not a missing comparison', () => {
    expect(normalizeUnitPrice(0, 'ea')).toEqual({
      family: 'count',
      unit: 'ea',
      priceMinor: 0,
    });
  });
});

describe('summarizeItemPrices', () => {
  const item = { id: 'item-1', name: 'Milk' };

  it('aggregates one store per family and keeps non-normalizable spend', () => {
    const history: PriceHistoryRow[] = [
      row({
        receiptId: 'r1',
        receiptCreatedAt: '2026-10-01T12:00:00.000Z',
        lineId: 'l1',
        printedText: 'MILK 2.00 LB',
        quantityUnit: 'lb',
        quantityReal: 2,
        unitPriceMinor: 499,
        totalPriceMinor: 998,
      }),
      row({
        receiptId: 'r2',
        receiptCreatedAt: '2026-10-08T12:00:00.000Z',
        lineId: 'l2',
        printedText: 'MILK 1 KG',
        quantityUnit: 'kg',
        quantityReal: 1,
        unitPriceMinor: 1100,
        totalPriceMinor: 1100,
      }),
      row({
        receiptId: 'r3',
        receiptCreatedAt: '2026-10-15T12:00:00.000Z',
        lineId: 'l3',
        printedText: 'MILK 1.00 LB',
        quantityUnit: 'lb',
        quantityReal: 1,
        unitPriceMinor: 549,
        totalPriceMinor: 549,
      }),
      // A unit the canonical set cannot name: no per-unit comparison, but the
      // money was really spent.
      row({
        receiptId: 'r4',
        receiptCreatedAt: '2026-10-15T18:00:00.000Z',
        lineId: 'l4',
        printedText: 'MILK PACK',
        quantityUnit: null,
        quantityReal: null,
        unitPriceMinor: null,
        totalPriceMinor: 300,
      }),
      row({
        receiptId: 'r5',
        receiptCreatedAt: '2026-10-16T12:00:00.000Z',
        lineId: 'l5',
        printedText: 'MILK 2 EA',
        quantityUnit: 'ea',
        quantityReal: 2,
        unitPriceMinor: null,
        totalPriceMinor: 600,
      }),
    ];

    const result = summarizeItemPrices(item, 'USD', history);

    expect(result).toEqual({
      catalogItemId: 'item-1',
      itemName: 'Milk',
      currency: 'USD',
      receiptCount: 5,
      lineCount: 5,
      spendMinor: 3547,
      stores: [
        {
          storeGroupId: 'store-1',
          storeName: 'Corner Market',
          lineCount: 5,
          spendMinor: 3547,
          lastPaidMinor: 600,
          lastPaidAt: '2026-10-16T12:00:00.000Z',
          lastReceiptId: 'r5',
          families: [
            {
              family: 'mass',
              unit: 'kg',
              lineCount: 3,
              lastUnitPriceMinor: 1210,
              minUnitPriceMinor: 1100,
              maxUnitPriceMinor: 1210,
              trend: 'up',
              history: [
                expect.objectContaining({
                  receiptId: 'r1',
                  lineId: 'l1',
                  receiptCreatedAt: '2026-10-01T12:00:00.000Z',
                  totalPriceMinor: 998,
                  quantityReal: 2,
                  quantityUnit: 'lb',
                  normalizedUnitPriceMinor: 1100,
                  printedText: 'MILK 2.00 LB',
                }),
                expect.objectContaining({
                  receiptId: 'r2',
                  normalizedUnitPriceMinor: 1100,
                }),
                expect.objectContaining({
                  receiptId: 'r3',
                  normalizedUnitPriceMinor: 1210,
                }),
              ],
            },
            {
              family: 'count',
              unit: 'ea',
              lineCount: 1,
              lastUnitPriceMinor: 300,
              minUnitPriceMinor: 300,
              maxUnitPriceMinor: 300,
              trend: 'unknown',
              history: [
                expect.objectContaining({
                  receiptId: 'r5',
                  normalizedUnitPriceMinor: 300,
                  quantityUnit: 'ea',
                  quantityReal: 2,
                }),
              ],
            },
          ],
        },
      ],
    });
  });

  it('keeps mass, volume and count separate instead of comparing them', () => {
    const result = summarizeItemPrices(item, 'USD', [
      row({
        receiptCreatedAt: '2026-10-01T12:00:00.000Z',
        quantityUnit: 'lb',
        quantityReal: 1,
        unitPriceMinor: 499,
        totalPriceMinor: 499,
      }),
      row({
        receiptCreatedAt: '2026-10-02T12:00:00.000Z',
        quantityUnit: 'l',
        quantityReal: 1,
        unitPriceMinor: 129,
        totalPriceMinor: 129,
      }),
      row({
        receiptCreatedAt: '2026-10-03T12:00:00.000Z',
        quantityUnit: 'ea',
        quantityReal: 1,
        unitPriceMinor: 150,
        totalPriceMinor: 150,
      }),
    ]);

    const families = result.stores[0]!.families;
    expect(families.map((family) => family.family)).toEqual([
      'mass',
      'volume',
      'count',
    ]);
    // Each family's min/max covers its own points only: no cross-family number.
    expect(families.map((family) => family.minUnitPriceMinor)).toEqual([
      1100, 129, 150,
    ]);
    expect(families.map((family) => family.maxUnitPriceMinor)).toEqual([
      1100, 129, 150,
    ]);
  });

  it('orders stores by their most recent receipt, newest first', () => {
    const result = summarizeItemPrices(item, 'USD', [
      row({
        storeGroupId: 'store-a',
        storeName: 'Alpha',
        receiptCreatedAt: '2026-10-01T12:00:00.000Z',
      }),
      row({
        storeGroupId: 'store-b',
        storeName: 'Beta',
        receiptCreatedAt: '2026-10-05T12:00:00.000Z',
      }),
      row({
        storeGroupId: 'store-a',
        storeName: 'Alpha',
        receiptCreatedAt: '2026-10-07T12:00:00.000Z',
      }),
    ]);

    expect(result.stores.map((store) => store.storeName)).toEqual([
      'Alpha',
      'Beta',
    ]);
  });

  it('reports a store whose lines cannot be normalized at all', () => {
    const result = summarizeItemPrices(item, 'USD', [
      row({
        quantityUnit: null,
        quantityReal: null,
        unitPriceMinor: null,
        totalPriceMinor: 700,
        receiptCreatedAt: '2026-10-09T12:00:00.000Z',
      }),
    ]);

    expect(result.stores[0]).toEqual(
      expect.objectContaining({
        lineCount: 1,
        spendMinor: 700,
        lastPaidMinor: 700,
        families: [],
      }),
    );
  });

  it('reports an item with no committed lines without inventing a store', () => {
    expect(summarizeItemPrices(item, 'USD', [])).toEqual({
      catalogItemId: 'item-1',
      itemName: 'Milk',
      currency: 'USD',
      receiptCount: 0,
      lineCount: 0,
      spendMinor: 0,
      stores: [],
    });
  });

  it('trends down and flat from the last two comparable points', () => {
    const down = summarizeItemPrices(item, 'USD', [
      row({
        receiptCreatedAt: '2026-10-01T12:00:00.000Z',
        unitPriceMinor: 200,
        totalPriceMinor: 200,
      }),
      row({
        receiptCreatedAt: '2026-10-02T12:00:00.000Z',
        unitPriceMinor: 150,
        totalPriceMinor: 150,
      }),
    ]);
    expect(down.stores[0]!.families[0]!.trend).toBe('down');

    const flat = summarizeItemPrices(item, 'USD', [
      row({
        receiptCreatedAt: '2026-10-01T12:00:00.000Z',
        unitPriceMinor: 150,
        totalPriceMinor: 150,
      }),
      row({
        receiptCreatedAt: '2026-10-02T12:00:00.000Z',
        unitPriceMinor: 150,
        totalPriceMinor: 150,
      }),
    ]);
    expect(flat.stores[0]!.families[0]!.trend).toBe('flat');
  });

  it('does not call two variants on one receipt a trend', () => {
    const result = summarizeItemPrices(item, 'USD', [
      row({
        receiptId: 'same-trip',
        receiptCreatedAt: '2026-10-02T12:00:00.000Z',
        unitPriceMinor: 150,
        totalPriceMinor: 150,
      }),
      row({
        receiptId: 'same-trip',
        receiptCreatedAt: '2026-10-02T12:00:00.000Z',
        unitPriceMinor: 250,
        totalPriceMinor: 250,
      }),
    ]);

    const family = result.stores[0]!.families[0]!;
    expect(family.lineCount).toBe(2);
    expect(family.minUnitPriceMinor).toBe(150);
    expect(family.maxUnitPriceMinor).toBe(250);
    expect(family.lastUnitPriceMinor).toBe(250);
    expect(family.trend).toBe('unknown');
  });
});
