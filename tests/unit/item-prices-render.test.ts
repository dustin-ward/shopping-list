import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import ItemPrices from '../../src/lib/components/items/ItemPrices.svelte';
import { formatMoney } from '../../src/lib/client/money';
import type {
  ItemPriceFamily,
  ItemPricePoint,
  ItemPrices as ItemPricesBody,
  ItemStorePrices,
} from '../../src/lib/shared/schemas';

/**
 * The Prices sheet as the household meets it: last paid per store, one trend
 * per measurable family, a link back to the committed receipt that holds the
 * price, and an honest empty state when nothing has been committed yet.
 */

function readable(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/ svelte-\w+/gu, '')
    .replace(/\s+/gu, ' ');
}

function point(
  receiptId: string,
  priceMinor: number,
  receiptCreatedAt: string,
): ItemPricePoint {
  return {
    receiptId,
    lineId: `line-${receiptId}`,
    receiptCreatedAt,
    printedText: 'BANANAS 2.15LB @ 0.59/LB',
    quantityReal: 2.15,
    quantityUnit: 'lb',
    totalPriceMinor: 127,
    normalizedUnitPriceMinor: priceMinor,
  };
}

function family(
  history: ItemPricePoint[],
  overrides: Partial<ItemPriceFamily> = {},
): ItemPriceFamily {
  const prices = history.map((entry) => entry.normalizedUnitPriceMinor);
  return {
    family: 'mass',
    unit: 'kg',
    lineCount: history.length,
    lastUnitPriceMinor: prices.at(-1) ?? 0,
    minUnitPriceMinor: Math.min(...prices),
    maxUnitPriceMinor: Math.max(...prices),
    trend: history.length > 1 ? 'up' : 'unknown',
    history,
    ...overrides,
  };
}

function store(overrides: Partial<ItemStorePrices> = {}): ItemStorePrices {
  return {
    storeGroupId: 'store-hen-house',
    storeName: 'Hen House',
    lineCount: 3,
    spendMinor: 1047,
    lastPaidMinor: 349,
    lastPaidAt: new Date(2026, 9, 15, 12, 0).toISOString(),
    lastReceiptId: 'receipt-hen-house',
    families: [],
    ...overrides,
  };
}

function prices(overrides: Partial<ItemPricesBody> = {}): ItemPricesBody {
  return {
    catalogItemId: 'item-milk',
    itemName: 'Milk',
    currency: 'USD',
    receiptCount: 3,
    lineCount: 3,
    spendMinor: 1047,
    stores: [store()],
    ...overrides,
  };
}

const now = new Date(2026, 9, 22, 9, 30);

type Props = {
  prices?: ItemPricesBody | null;
  loading?: boolean;
  error?: string;
};

function renderSheet({
  prices: body = prices(),
  loading = false,
  error = '',
}: Props = {}): string {
  return readable(
    render(ItemPrices, {
      props: {
        item: { id: 'item-milk', name: 'Milk' },
        prices: body,
        loading,
        error,
        now,
        onClose: () => {},
        onOpenReceipt: () => {},
      },
    }).body,
  );
}

describe('ItemPrices — the item and its receipts', () => {
  it('names the item and counts what the history covers', () => {
    const body = renderSheet();

    expect(body).toContain('>Prices for Milk</h2>');
    expect(body).toContain('3 committed receipts');
    expect(body).toContain('3 lines');
    expect(body).toContain(formatMoney(1047, 'USD'));
  });

  it('shows one row per store with last paid and the receipt link', () => {
    const body = renderSheet({
      prices: prices({
        stores: [
          store(),
          store({
            storeGroupId: 'store-corner',
            storeName: 'Corner Market',
            lastPaidMinor: 499,
            lastPaidAt: new Date(2026, 9, 21, 12, 0).toISOString(),
            lastReceiptId: 'receipt-corner',
          }),
        ],
      }),
    });

    expect(body).toContain('>Hen House</h3>');
    expect(body).toContain('>Corner Market</h3>');
    expect(body).toContain(`Last paid ${formatMoney(349, 'USD')} last week`);
    expect(body).toContain(`Last paid ${formatMoney(499, 'USD')} yesterday`);
    // Each row links to its own committed receipt.
    expect(body).toContain('aria-label="Open receipt from Hen House"');
    expect(body).toContain('aria-label="Open receipt from Corner Market"');
  });

  it('says when a cleared total left no amount to quote', () => {
    const body = renderSheet({
      prices: prices({
        stores: [store({ lastPaidMinor: null })],
      }),
    });

    expect(body).toContain('Last paid amount not recorded');
  });
});

describe('ItemPrices — trends inside a family', () => {
  it('draws a sparkline, names the direction and keeps min and max', () => {
    const body = renderSheet({
      prices: prices({
        stores: [
          store({
            families: [
              family([
                point('receipt-1', 120, '2026-09-20T12:00:00.000Z'),
                point('receipt-2', 140, '2026-10-01T12:00:00.000Z'),
                point('receipt-3', 130, '2026-10-15T12:00:00.000Z'),
              ]),
            ],
          }),
        ],
      }),
    });

    expect(body).toContain('>Mass</span>');
    expect(body).toContain(`${formatMoney(130, 'USD')} per kg`);
    expect(body).toContain('Up from last time');
    expect(body).toContain(
      `Low ${formatMoney(120, 'USD')} · High ${formatMoney(140, 'USD')}`,
    );
    // The polyline is the three prices and the last point is marked.
    expect(body).toMatch(/<polyline[^>]*points="[^"]+"/u);
    expect(body).toContain('<circle');
    expect(body).toContain('Unit price per kg across 3 receipts at Hen House');
  });

  it('does not fake a trend from a single recorded price', () => {
    const body = renderSheet({
      prices: prices({
        stores: [
          store({
            families: [
              family([point('receipt-1', 150, '2026-10-15T12:00:00.000Z')]),
            ],
          }),
        ],
      }),
    });

    expect(body).toContain('Not enough history to trend');
    expect(body).not.toContain('<polyline');
    expect(body).toContain('One recorded unit price per kg at Hen House');
  });

  it('never invents a comparison for store lines with no normalizable unit', () => {
    const body = renderSheet({
      prices: prices({
        stores: [
          store({
            families: [],
          }),
        ],
      }),
    });

    expect(body).toContain(
      'No comparable unit price yet — these lines have no unit that can be normalized.',
    );
    expect(body).not.toContain('>Mass</span>');
  });
});

describe('ItemPrices — the states around the data', () => {
  it('explains an item with no committed receipts', () => {
    const body = renderSheet({
      prices: prices({
        receiptCount: 0,
        lineCount: 0,
        spendMinor: 0,
        stores: [],
      }),
    });

    // The empty state says it once; the header adds no duplicate summary.
    expect(body.match(/No committed receipts yet/gu)).toHaveLength(1);
    expect(body).toContain(
      'Prices appear here once a receipt with this item is committed.',
    );
    expect(body).not.toContain('Open receipt');
  });

  it('says it is loading before the first answer', () => {
    expect(renderSheet({ prices: null, loading: true })).toContain(
      'Loading prices…',
    );
  });

  it('shows a read failure as an alert', () => {
    const body = renderSheet({
      prices: null,
      error: 'Prices are unavailable. Try again.',
    });

    expect(body).toContain('role="alert"');
    expect(body).toContain('Prices are unavailable. Try again.');
    // The sheet offers the retry its container owns rather than making the
    // reviewer close and reopen it.
    expect(body).toContain('>Try again</button>');
  });

  it('offers a close control for the sheet', () => {
    expect(renderSheet()).toContain('>Close</button>');
  });
});
