import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DELTA_WARNING_MIN_MINOR,
  deltaExceedsThreshold,
  itemLinesTotalMinor,
  receiptTotals,
} from '../../src/lib/shared/receipt-totals';
import { parseReceiptOcr } from '../../src/lib/server/receipts/parser';

/** One parsed line, as the arithmetic sees it. */
function line(totalPriceMinor: number | null, isItemChunk = true) {
  return { isItemChunk, totalPriceMinor };
}

function fixture(name: string) {
  return parseReceiptOcr(
    readFileSync(
      resolve(process.cwd(), `tests/fixtures/receipts/${name}.json`),
      'utf8',
    ),
  );
}

describe('itemLinesTotalMinor', () => {
  it('adds the item lines only, keeping parked rows out of the sum', () => {
    expect(
      itemLinesTotalMinor([
        line(349),
        line(-150, false),
        line(499),
        line(null, false),
      ]),
    ).toBe(848);
  });

  it('is zero for a receipt with no lines', () => {
    expect(itemLinesTotalMinor([])).toBe(0);
  });
});

describe('receiptTotals', () => {
  it('measures the delta against the subtotal and reports the printed totals', () => {
    const totals = receiptTotals({
      lines: [line(349), line(499), line(1755, false)],
      subtotalMinor: 800,
      taxMinor: 48,
      totalMinor: 848,
    });

    expect(totals).toEqual({
      itemsMinor: 848,
      subtotalMinor: 800,
      taxMinor: 48,
      totalMinor: 848,
      deltaMinor: 48,
      deltaReference: 'subtotal',
      deltaWarns: true,
    });
  });

  it('falls back to the total when the receipt prints no subtotal', () => {
    const totals = receiptTotals({
      lines: [line(500)],
      subtotalMinor: null,
      taxMinor: null,
      totalMinor: 500,
    });

    expect(totals.deltaMinor).toBe(0);
    expect(totals.deltaReference).toBe('total');
    expect(totals.deltaWarns).toBe(false);
  });

  it('has no sum or delta without item lines', () => {
    const totals = receiptTotals({
      lines: [line(1755, false), line(105, false)],
      subtotalMinor: 1755,
      taxMinor: 105,
      totalMinor: 1860,
    });

    expect(totals.itemsMinor).toBeNull();
    expect(totals.deltaMinor).toBeNull();
    expect(totals.deltaReference).toBeNull();
    expect(totals.deltaWarns).toBe(false);
  });

  it('has no delta when the receipt prints neither subtotal nor total', () => {
    const totals = receiptTotals({
      lines: [line(625)],
      subtotalMinor: null,
      taxMinor: null,
      totalMinor: null,
    });

    expect(totals.itemsMinor).toBe(625);
    expect(totals.deltaMinor).toBeNull();
    expect(totals.deltaWarns).toBe(false);
  });
});

describe('deltaExceedsThreshold', () => {
  it('stays quiet at the five-cent floor and warns past it', () => {
    expect(DELTA_WARNING_MIN_MINOR).toBe(5);
    expect(deltaExceedsThreshold(5, 100)).toBe(false);
    expect(deltaExceedsThreshold(6, 100)).toBe(true);
  });

  it('uses one percent of the total once that is the larger half', () => {
    // 1% of $8.00 is 8¢, so an 8¢ gap is rounding and a 9¢ gap is not.
    expect(deltaExceedsThreshold(8, 800)).toBe(false);
    expect(deltaExceedsThreshold(9, 800)).toBe(true);
    // 1% of $100.00 is $1.00.
    expect(deltaExceedsThreshold(100, 10000)).toBe(false);
    expect(deltaExceedsThreshold(101, 10000)).toBe(true);
  });

  it('compares the size of the gap, whichever way it runs', () => {
    expect(deltaExceedsThreshold(-230, 2769)).toBe(true);
    expect(deltaExceedsThreshold(-4, 2769)).toBe(false);
  });
});

describe('the totals strip over the committed fixtures', () => {
  it('warns about the coupons receipt: the parked adjustments show up as the delta', () => {
    const parsed = fixture('coupons-negatives');
    const totals = receiptTotals({
      lines: parsed.lines,
      subtotalMinor: parsed.subtotalMinor,
      taxMinor: parsed.taxMinor,
      totalMinor: parsed.totalMinor,
    });

    expect(totals.itemsMinor).toBe(2794);
    expect(totals.subtotalMinor).toBe(2564);
    expect(totals.totalMinor).toBe(2769);
    expect(totals.deltaMinor).toBe(230);
    expect(totals.deltaReference).toBe('subtotal');
    expect(totals.deltaWarns).toBe(true);
  });

  it('stays silent when the item lines add up, as on the clean grocery receipt', () => {
    const parsed = fixture('clean-grocery');
    const totals = receiptTotals({
      lines: parsed.lines,
      subtotalMinor: parsed.subtotalMinor,
      taxMinor: parsed.taxMinor,
      totalMinor: parsed.totalMinor,
    });

    expect(totals.itemsMinor).toBe(3949);
    expect(totals.deltaMinor).toBe(0);
    expect(totals.deltaWarns).toBe(false);
  });

  it('stays silent on the stub receipt the e2e flow captures', () => {
    const parsed = fixture('stub-ocr');
    const totals = receiptTotals({
      lines: parsed.lines,
      subtotalMinor: parsed.subtotalMinor,
      taxMinor: parsed.taxMinor,
      totalMinor: parsed.totalMinor,
    });

    expect(totals.itemsMinor).toBe(1755);
    expect(totals.deltaMinor).toBe(0);
    expect(totals.deltaWarns).toBe(false);
  });

  it('has nothing to compare on the washed-out receipt', () => {
    const parsed = fixture('washed-out');
    const totals = receiptTotals({
      lines: parsed.lines,
      subtotalMinor: parsed.subtotalMinor,
      taxMinor: parsed.taxMinor,
      totalMinor: parsed.totalMinor,
    });

    expect(totals.itemsMinor).toBe(625);
    expect(totals.subtotalMinor).toBeNull();
    expect(totals.totalMinor).toBeNull();
    expect(totals.deltaMinor).toBeNull();
    expect(totals.deltaWarns).toBe(false);
  });
});
