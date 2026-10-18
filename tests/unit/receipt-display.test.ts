import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ambiguousLineHint,
  receiptLineView,
  totalsWarningText,
  type ReceiptLineFields,
} from '../../src/lib/client/receipt-display';
import {
  receiptTotals,
  type ReceiptTotals,
} from '../../src/lib/shared/receipt-totals';
import { parseReceiptOcr } from '../../src/lib/server/receipts/parser';

/** An item line with the fields under test, everything else empty. */
function fields(overrides: Partial<ReceiptLineFields> = {}): ReceiptLineFields {
  return {
    rawText: 'MILK 2% 1L',
    parsedName: 'MILK 2% 1L',
    quantityReal: null,
    quantityText: null,
    quantityUnit: null,
    unitPriceMinor: null,
    totalPriceMinor: 349,
    isItemChunk: true,
    ...overrides,
  };
}

function fixture(name: string) {
  return parseReceiptOcr(
    readFileSync(
      resolve(process.cwd(), `tests/fixtures/receipts/${name}.json`),
      'utf8',
    ),
  );
}

describe('receiptLineView', () => {
  it('shows a count and its unit, the price per unit and the line total', () => {
    expect(
      receiptLineView(
        fields({
          rawText: 'CUCUMBERS 2 @ 1.50',
          parsedName: 'CUCUMBERS',
          quantityReal: 2,
          quantityText: '2 @ 1.50',
          quantityUnit: 'ea',
          unitPriceMinor: 150,
          totalPriceMinor: 300,
        }),
      ),
    ).toEqual({
      printedText: 'CUCUMBERS 2 @ 1.50',
      parsedName: 'CUCUMBERS',
      quantity: '2 ea',
      unitPriceMinor: 150,
      unitPriceSuffix: '/ea',
      totalPriceMinor: 300,
      parked: false,
    });
  });

  it('shows a scale weight with its canonical unit', () => {
    const view = receiptLineView(
      fields({
        rawText: 'BANANAS 2.15LB @ 0.59/LB',
        parsedName: 'BANANAS',
        quantityReal: 2.15,
        quantityText: '2.15LB @ 0.59/LB',
        quantityUnit: 'lb',
        unitPriceMinor: 59,
        totalPriceMinor: 127,
      }),
    );

    expect(view.quantity).toBe('2.15 lb');
    expect(view.unitPriceSuffix).toBe('/lb');
  });

  it('drops the unit suffix when the printed unit is not a canonical one', () => {
    const view = receiptLineView(
      fields({
        rawText: 'TORTILLAS 2 BOX @ 3.00',
        parsedName: 'TORTILLAS',
        quantityReal: 2,
        quantityText: '2 BOX @ 3.00',
        quantityUnit: null,
        unitPriceMinor: 300,
        totalPriceMinor: 600,
      }),
    );

    // The printed indicator stands in: the parser read a count but no unit it
    // can name, and a bare "2" is not what the receipt says.
    expect(view.quantity).toBe('2 BOX @ 3.00');
    expect(view.unitPriceSuffix).toBeNull();
  });

  it('falls back to the verbatim printed indicator when no quantity was read', () => {
    const view = receiptLineView(
      fields({
        rawText: 'CIDER GALLON',
        parsedName: 'CIDER GALLON',
        quantityReal: null,
        quantityText: 'GALLON',
        quantityUnit: null,
        unitPriceMinor: 899,
        totalPriceMinor: 899,
      }),
    );

    expect(view.quantity).toBe('GALLON');
    expect(view.unitPriceMinor).toBe(899);
  });

  it('shows the parsed name on an item line, and none on a parked row', () => {
    expect(receiptLineView(fields()).parsedName).toBe('MILK 2% 1L');
    expect(receiptLineView(fields({ parsedName: null })).parsedName).toBeNull();
    expect(
      receiptLineView(fields({ parsedName: null, isItemChunk: false }))
        .parsedName,
    ).toBeNull();
  });

  it('carries a parked row through with its printed text and amount', () => {
    expect(
      receiptLineView(
        fields({
          rawText: 'SUBTOTAL',
          parsedName: null,
          totalPriceMinor: 1755,
          isItemChunk: false,
        }),
      ),
    ).toEqual({
      printedText: 'SUBTOTAL',
      parsedName: null,
      quantity: null,
      unitPriceMinor: null,
      unitPriceSuffix: null,
      totalPriceMinor: 1755,
      parked: true,
    });
  });

  it('maps every line of the clean grocery fixture without inventing anything', () => {
    const parsed = fixture('clean-grocery');

    for (const line of parsed.lines) {
      const view = receiptLineView(line);
      expect(view.printedText).toBe(line.rawText.trim());
      expect(view.parked).toBe(!line.isItemChunk);
      expect(view.totalPriceMinor).toBe(line.totalPriceMinor);
      expect(view.unitPriceMinor).toBe(line.unitPriceMinor);
      expect(view.unitPriceSuffix).toBe(
        line.unitPriceMinor === null || line.quantityUnit === null
          ? null
          : `/${line.quantityUnit}`,
      );
      expect(view.quantity).toBe(
        line.quantityReal === null
          ? null
          : line.quantityUnit
            ? `${line.quantityReal} ${line.quantityUnit}`
            : line.quantityText,
      );
    }

    const cucumbers = parsed.lines.find((line) =>
      line.rawText.startsWith('CUCUMBERS'),
    );
    expect(cucumbers).toBeDefined();
    expect(receiptLineView(cucumbers!)).toMatchObject({
      parsedName: 'CUCUMBERS',
      quantity: '2 ea',
      unitPriceMinor: 150,
      unitPriceSuffix: '/ea',
      totalPriceMinor: 300,
    });
  });
});

describe('totalsWarningText', () => {
  const money = (minor: number) => `$${(minor / 100).toFixed(2)}`;

  function totalsOf(name: string): ReceiptTotals {
    const parsed = fixture(name);
    return receiptTotals({
      lines: parsed.lines,
      subtotalMinor: parsed.subtotalMinor,
      taxMinor: parsed.taxMinor,
      totalMinor: parsed.totalMinor,
    });
  }

  it('names the sum, the printed reference and the difference above the threshold', () => {
    expect(totalsWarningText(totalsOf('coupons-negatives'), money)).toBe(
      'The item lines total $27.94 but the subtotal reads $25.64 — a difference of $2.30.',
    );
  });

  it('stays silent below the threshold', () => {
    expect(totalsWarningText(totalsOf('clean-grocery'), money)).toBeNull();
    expect(totalsWarningText(totalsOf('stub-ocr'), money)).toBeNull();
    expect(totalsWarningText(totalsOf('washed-out'), money)).toBeNull();
  });

  it('names the total when the receipt prints no subtotal', () => {
    const totals = receiptTotals({
      lines: [{ isItemChunk: true, totalPriceMinor: 1000 }],
      subtotalMinor: null,
      taxMinor: null,
      totalMinor: 900,
    });

    expect(totalsWarningText(totals, money)).toBe(
      'The item lines total $10.00 but the total reads $9.00 — a difference of $1.00.',
    );
  });
});

describe('ambiguousLineHint', () => {
  const suggestion = (tier: 1 | 2) => ({
    catalogItemId: `00000000-0000-4000-8000-00000000000${tier}`,
    name: tier === 1 ? 'Cereal' : 'Granola',
    tier,
    score: 1,
    sameStore: false,
  });

  it('explains a line two items claim, so the reviewer knows why matching asked', () => {
    expect(
      ambiguousLineHint({
        reviewState: 'unreviewed',
        suggestions: [suggestion(1), suggestion(1)],
      }),
    ).toBe('2 items claim this phrase — matching asks instead of guessing.');
  });

  it('stays silent on a single candidate and on fuzzy ones', () => {
    expect(
      ambiguousLineHint({
        reviewState: 'unreviewed',
        suggestions: [suggestion(1)],
      }),
    ).toBeNull();
    expect(
      ambiguousLineHint({
        reviewState: 'unreviewed',
        suggestions: [suggestion(2), suggestion(2)],
      }),
    ).toBeNull();
    expect(
      ambiguousLineHint({ reviewState: 'unreviewed', suggestions: [] }),
    ).toBeNull();
  });

  it('stops explaining once the reviewer has decided the line', () => {
    const claimed = [suggestion(1), suggestion(1)];
    for (const reviewState of ['bound', 'unknown', 'skipped', 'new'] as const) {
      expect(
        ambiguousLineHint({ reviewState, suggestions: claimed }),
      ).toBeNull();
    }
  });
});
