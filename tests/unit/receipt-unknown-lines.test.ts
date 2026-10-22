import { describe, expect, it } from 'vitest';
import {
  groupUnknownLines,
  unknownLinesOverview,
  type UnknownLineRow,
} from '../../src/lib/server/receipts/unknown-lines';

/**
 * The unknown-line grouped browser's pure half (ticket 17): a group is a
 * normalized printed phrase, not a row, and the numbers it carries are the
 * unidentified-spending view.
 */

function row(
  overrides: Partial<UnknownLineRow> &
    Pick<UnknownLineRow, 'lineId' | 'rawText'>,
): UnknownLineRow {
  return {
    parsedName: null,
    totalPriceMinor: null,
    quantityReal: null,
    unitPriceMinor: null,
    receiptId: '00000000-0000-4000-8000-000000000001',
    committedAt: '2026-10-15T10:00:00.000Z',
    lineIndex: 0,
    ...overrides,
  };
}

describe('groupUnknownLines', () => {
  it('groups lines by normalized printed text, across receipts', () => {
    const groups = groupUnknownLines([
      row({
        lineId: 'line-a',
        rawText: 'MYSTERY ITEM',
        receiptId: 'receipt-a',
        committedAt: '2026-10-15T10:00:00.000Z',
      }),
      row({
        lineId: 'line-b',
        rawText: ' mystery item ',
        receiptId: 'receipt-b',
        committedAt: '2026-10-16T10:00:00.000Z',
      }),
      row({ lineId: 'line-c', rawText: 'SOMETHING ELSE' }),
    ]);

    expect(groups.map((group) => group.normalizedText)).toEqual([
      'mystery item',
      'something else',
    ]);
  });

  it('keeps the matcher phrase separate from the printed grouping text', () => {
    const groups = groupUnknownLines([
      row({
        lineId: 'line-a',
        rawText: 'CUCUMBERS 2 @ 1.50',
        parsedName: 'CUCUMBERS',
      }),
    ]);

    expect(groups[0]).toMatchObject({
      normalizedText: 'cucumbers 2 @ 1.50',
      printedText: 'CUCUMBERS 2 @ 1.50',
      matchingPhrase: 'CUCUMBERS',
    });
  });

  it('normalizes the way aliases and item names do (case, spacing, NFKC)', () => {
    const groups = groupUnknownLines([
      row({ lineId: 'line-a', rawText: 'ＭＹＳＴＥＲＹ  ＩＴＥＭ' }),
      row({ lineId: 'line-b', rawText: 'mystery item' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.normalizedText).toBe('mystery item');
    expect(groups[0]!.lineCount).toBe(2);
  });

  it('counts lines and distinct receipts, and sums the unidentified spend', () => {
    const groups = groupUnknownLines([
      row({
        lineId: 'line-a',
        rawText: 'MYSTERY ITEM',
        totalPriceMinor: 349,
        receiptId: 'receipt-a',
      }),
      row({
        lineId: 'line-b',
        rawText: 'mystery item',
        totalPriceMinor: 250,
        receiptId: 'receipt-b',
      }),
      // The same receipt, another printing of the same phrase.
      row({
        lineId: 'line-c',
        rawText: 'MYSTERY ITEM',
        totalPriceMinor: 101,
        receiptId: 'receipt-a',
      }),
      // A line the text read but with no price still counts; it adds nothing.
      row({
        lineId: 'line-d',
        rawText: 'MYSTERY ITEM',
        totalPriceMinor: null,
        receiptId: 'receipt-c',
      }),
    ]);

    expect(groups[0]).toMatchObject({
      normalizedText: 'mystery item',
      lineCount: 4,
      receiptCount: 3,
      spendMinor: 700,
    });
  });

  it('keeps the most recently committed printed wording for display', () => {
    const groups = groupUnknownLines([
      row({
        lineId: 'line-old',
        rawText: 'OLD  MYSTERY',
        committedAt: '2026-10-14T10:00:00.000Z',
      }),
      row({
        lineId: 'line-new',
        rawText: 'OLD MYSTERY',
        committedAt: '2026-10-16T10:00:00.000Z',
      }),
    ]);

    expect(groups[0]!.printedText).toBe('OLD MYSTERY');
    // The written lines follow the same newest-first order, so the alias is
    // learned from the wording the view showed.
    expect(groups[0]!.lineIds).toEqual(['line-new', 'line-old']);
  });

  it('orders the groups by unidentified spend, then by phrase', () => {
    const groups = groupUnknownLines([
      row({ lineId: 'line-a', rawText: 'SMALL', totalPriceMinor: 100 }),
      row({ lineId: 'line-b', rawText: 'BIG', totalPriceMinor: 900 }),
      row({ lineId: 'line-c', rawText: 'ALSO SMALL', totalPriceMinor: 100 }),
    ]);

    expect(groups.map((group) => group.normalizedText)).toEqual([
      'big',
      'also small',
      'small',
    ]);
  });

  it('keeps a phrase that normalizes to nothing as unidentified spend', () => {
    const groups = groupUnknownLines([
      row({ lineId: 'line-a', rawText: '   ', totalPriceMinor: 125 }),
      row({ lineId: 'line-b', rawText: '\n', totalPriceMinor: 75 }),
      row({ lineId: 'line-c', rawText: 'REAL', totalPriceMinor: 50 }),
    ]);

    expect(groups.map((group) => group.normalizedText)).toEqual(['', 'real']);
    expect(groups[0]).toMatchObject({
      normalizedText: '',
      printedText: '',
      lineCount: 2,
      spendMinor: 200,
    });
  });

  it('prices a line from its quantity when the total price was not read', () => {
    const groups = groupUnknownLines([
      row({
        lineId: 'line-a',
        rawText: 'TWO AT',
        quantityReal: 2,
        unitPriceMinor: 150,
      }),
      row({
        lineId: 'line-b',
        rawText: 'two at',
        quantityReal: 2.15,
        unitPriceMinor: 59,
      }),
      // A printed total wins over the extended unit price.
      row({
        lineId: 'line-c',
        rawText: 'TWO AT',
        quantityReal: 2,
        unitPriceMinor: 150,
        totalPriceMinor: 275,
      }),
    ]);

    expect(groups[0]).toMatchObject({
      normalizedText: 'two at',
      lineCount: 3,
      spendMinor: 702,
    });
  });
});

describe('unknownLinesOverview', () => {
  it('totals the groups and leaves the internal row ids out of the payload', () => {
    const groups = groupUnknownLines([
      row({
        lineId: 'line-a',
        rawText: 'MYSTERY ITEM',
        totalPriceMinor: 349,
        receiptId: 'receipt-a',
      }),
      row({
        lineId: 'line-b',
        rawText: 'ANOTHER MYSTERY',
        totalPriceMinor: 250,
        receiptId: 'receipt-b',
      }),
    ]);

    const overview = unknownLinesOverview(groups, 'USD');

    expect(overview).toEqual({
      currency: 'USD',
      groups: [
        {
          normalizedText: 'mystery item',
          printedText: 'MYSTERY ITEM',
          lineCount: 1,
          receiptCount: 1,
          spendMinor: 349,
        },
        {
          normalizedText: 'another mystery',
          printedText: 'ANOTHER MYSTERY',
          lineCount: 1,
          receiptCount: 1,
          spendMinor: 250,
        },
      ],
      lineCount: 2,
      spendMinor: 599,
    });
    expect('lineIds' in overview.groups[0]!).toBe(false);
    expect('receiptIds' in overview.groups[0]!).toBe(false);
  });

  it('is an empty, zero-spend view when nothing is unidentified', () => {
    expect(unknownLinesOverview([], 'USD')).toEqual({
      currency: 'USD',
      groups: [],
      lineCount: 0,
      spendMinor: 0,
    });
  });
});
