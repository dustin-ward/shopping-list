import { describe, expect, it } from 'vitest';
import {
  deltaExceedsThreshold,
  parseReceiptOcr,
} from '../../src/lib/server/receipts/parser';

type Line = { text: string; y: number; x?: number; conf?: number };

/** A payload in the sidecar's §9 shape; names at x=40, prices near x=800. */
function payload(lines: Line[], blocks: unknown[] = []): string {
  return JSON.stringify({
    pages: [
      {
        lines: lines.map(({ text, y, x = 40, conf = 0.95 }) => ({
          box: [x, y, x + text.length * 9, y + 14],
          text,
          conf,
        })),
        blocks,
        rotation: 0,
        skew: 0,
        source: 'unit',
      },
    ],
    engine: { name: 'indra-ocr', model_tag: 'test', package_version: '0' },
  });
}

/** A minimal priced receipt: one item, then its footer. */
function pricedReceipt(
  itemName: string,
  itemPrice: string,
  footer: Line[] = [],
): string {
  return payload([
    { text: itemName, y: 100 },
    { text: itemPrice, y: 100, x: 800 },
    ...footer,
  ]);
}

describe('parseReceiptOcr classification', () => {
  it('keeps item chunks and parks header, footer and tender rows', () => {
    const parsed = parseReceiptOcr(
      payload([
        { text: 'CORNER MARKET', y: 20 },
        { text: '123 MAIN STREET', y: 40 },
        { text: '2026-10-17 14:32', y: 60 },
        { text: 'MILK 2% 1L', y: 100 },
        { text: '3.49', y: 100, x: 800 },
        { text: 'SUBTOTAL', y: 140 },
        { text: '3.49', y: 140, x: 800 },
        { text: 'TAX', y: 160 },
        { text: '0.22', y: 160, x: 800 },
        { text: 'TOTAL', y: 180 },
        { text: '3.71', y: 180, x: 800 },
        { text: 'VISA ****1234', y: 200 },
        { text: '3.71', y: 200, x: 800 },
        { text: 'THANK YOU', y: 220 },
      ]),
    );

    expect(
      parsed.lines.map((row) => [
        row.rawText,
        row.isItemChunk,
        row.totalPriceMinor,
      ]),
    ).toEqual([
      ['CORNER MARKET', false, null],
      ['123 MAIN STREET', false, null],
      ['2026-10-17 14:32', false, null],
      ['MILK 2% 1L', true, 349],
      ['SUBTOTAL', false, 349],
      ['TAX', false, 22],
      ['TOTAL', false, 371],
      ['VISA ****1234', false, 371],
      ['THANK YOU', false, null],
    ]);
    expect(parsed.lines.filter((row) => row.isItemChunk)).toHaveLength(1);
    expect(parsed.subtotalMinor).toBe(349);
    expect(parsed.taxMinor).toBe(22);
    expect(parsed.totalMinor).toBe(371);
    expect(parsed.deltaMinor).toBe(0);
    expect(parsed.parseVersion).toBe(1);
  });

  it('parks rows a page header or footer block covers', () => {
    const parsed = parseReceiptOcr(
      payload(
        [
          { text: 'STORE 41', y: 20 },
          { text: 'MILK', y: 100 },
          { text: '3.49', y: 100, x: 800 },
          { text: 'THANK YOU', y: 200 },
        ],
        [
          { label: 'Page-Header', bbox: [0, 0, 900, 60], text: 'STORE 41' },
          { label: 'Page-Footer', bbox: [0, 180, 900, 240], text: 'THANK YOU' },
        ],
      ),
    );

    expect(parsed.lines.map((row) => [row.rawText, row.isItemChunk])).toEqual([
      ['STORE 41', false],
      ['MILK', true],
      ['THANK YOU', false],
    ]);
  });

  it('folds a wrapped name into the item row that carries its price', () => {
    const parsed = parseReceiptOcr(
      payload([
        { text: 'FLOUR TORTILLAS', y: 100 },
        { text: '3.89', y: 100, x: 800 },
        { text: 'ORG BABY SPINACH', y: 130 },
        { text: '16OZ CLAMSHELL', y: 160 },
        { text: '5.99', y: 160, x: 800 },
        { text: 'THANK YOU', y: 200 },
      ]),
    );

    const items = parsed.lines.filter((row) => row.isItemChunk);
    expect(items.map((row) => [row.rawText, row.totalPriceMinor])).toEqual([
      ['FLOUR TORTILLAS', 389],
      ['ORG BABY SPINACH 16OZ CLAMSHELL', 599],
    ]);
    // The tail after the last item also survives, as a parked row.
    expect(parsed.lines.at(-1)).toMatchObject({
      rawText: 'THANK YOU',
      isItemChunk: false,
    });
  });

  it('reads one printed row even when the name and price are separate boxes', () => {
    const parsed = parseReceiptOcr(
      payload([
        { text: '9.99', y: 100, x: 800 },
        { text: 'PAPER TOWELS 6CT', y: 100 },
      ]),
    );

    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0]).toMatchObject({
      rawText: 'PAPER TOWELS 6CT',
      parsedName: 'PAPER TOWELS 6CT',
      isItemChunk: true,
      totalPriceMinor: 999,
    });
  });

  it('does not route everyday words that sit one edit from a keyword', () => {
    const parsed = parseReceiptOcr(
      payload([
        { text: 'CAT FOOD', y: 100 },
        { text: '3.49', y: 100, x: 800 },
        { text: 'MAX PADS', y: 130 },
        { text: '5.99', y: 130, x: 800 },
        { text: 'SUBTOTAL', y: 180 },
        { text: '9.48', y: 180, x: 800 },
      ]),
    );

    // `CAT` is one edit from `VAT` and `MAX` one from `TAX`: a one-edit match
    // on a three-letter word is too vague to be a mangled keyword.
    expect(parsed.lines.map((row) => [row.rawText, row.isItemChunk])).toEqual([
      ['CAT FOOD', true],
      ['MAX PADS', true],
      ['SUBTOTAL', false],
    ]);
    expect(parsed.taxMinor).toBeNull();
  });

  it('routes footer keywords that OCR has dropped a letter from', () => {
    const parsed = parseReceiptOcr(
      payload([
        { text: 'MILK', y: 100 },
        { text: '3.49', y: 100, x: 800 },
        { text: 'SUB TOTAI', y: 140 },
        { text: '3.49', y: 140, x: 800 },
        { text: 'ТАX 8.00%', y: 160 },
        { text: '0.28', y: 160, x: 800 },
        { text: 'TOTA1', y: 180 },
        { text: '3.77', y: 180, x: 800 },
      ]),
    );

    expect(parsed.subtotalMinor).toBe(349);
    expect(parsed.taxMinor).toBe(28);
    expect(parsed.totalMinor).toBe(377);
    expect(parsed.lines.filter((row) => row.isItemChunk)).toHaveLength(1);
  });
});

describe('parseReceiptOcr money hygiene', () => {
  it('leaves an unreadable amount verbatim and says so', () => {
    const parsed = parseReceiptOcr(
      payload([
        { text: 'MILK', y: 100 },
        { text: '3.49', y: 100, x: 800 },
        { text: 'AUTHORIZATION', y: 140 },
        { text: '1.234.56', y: 140, x: 800 },
        { text: 'SUBTOTAL', y: 180 },
        { text: '3.49', y: 180, x: 800 },
      ]),
    );

    const authorization = parsed.lines.find(
      (row) => row.rawText === 'AUTHORIZATION 1.234.56',
    );
    expect(authorization).toMatchObject({
      isItemChunk: false,
      totalPriceMinor: null,
      sourceLineIndexes: [2, 3],
    });
    expect(parsed.warnings.join(' ')).toContain('1.234.56');
  });

  it('keeps a coupon as a negative parked amount, never an item', () => {
    const parsed = parseReceiptOcr(
      payload([
        { text: 'MILK', y: 100 },
        { text: '3.49', y: 100, x: 800 },
        { text: 'STORE COUPON', y: 140 },
        { text: '-1.50', y: 140, x: 800 },
        { text: 'SUBTOTAL', y: 180 },
        { text: '1.99', y: 180, x: 800 },
      ]),
    );

    expect(parsed.lines[1]).toMatchObject({
      rawText: 'STORE COUPON',
      isItemChunk: false,
      totalPriceMinor: -150,
    });
    // The eligible gap between the items and the subtotal is what the warning
    // is for: coupons, deposits and rounding are exactly this kind of delta.
    expect(parsed.deltaMinor).toBe(150);
    expect(parsed.warnings.join(' ')).toContain('1.50');
  });
});

describe('parseReceiptOcr quantities', () => {
  const forms: [string, string, Record<string, unknown>][] = [
    [
      'CUCUMBERS 2 @ 1.50',
      '3.00',
      {
        parsedName: 'CUCUMBERS',
        quantityReal: 2,
        quantityText: '2 @ 1.50',
        quantityUnit: 'ea',
        unitPriceMinor: 150,
        totalPriceMinor: 300,
      },
    ],
    [
      'SODA 2 X 0.75',
      '1.50',
      {
        parsedName: 'SODA',
        quantityReal: 2,
        quantityText: '2 X 0.75',
        quantityUnit: 'ea',
        unitPriceMinor: 75,
        totalPriceMinor: 150,
      },
    ],
    [
      'TORTILLAS 2 FOR 4.00',
      '4.00',
      {
        parsedName: 'TORTILLAS',
        quantityReal: 2,
        quantityText: '2 FOR 4.00',
        quantityUnit: 'ea',
        unitPriceMinor: 200,
        totalPriceMinor: 400,
      },
    ],
    [
      'BANANAS 2.15LB @ 0.59/LB',
      '1.27',
      {
        parsedName: 'BANANAS',
        quantityReal: 2.15,
        quantityText: '2.15LB @ 0.59/LB',
        quantityUnit: 'lb',
        unitPriceMinor: 59,
        totalPriceMinor: 127,
      },
    ],
    [
      'OLIVES QTY 2',
      '5.00',
      {
        parsedName: 'OLIVES',
        quantityReal: 2,
        quantityText: 'QTY 2',
        quantityUnit: 'ea',
        unitPriceMinor: null,
        totalPriceMinor: 500,
      },
    ],
    [
      'BAGELS 6 EA',
      '6.00',
      {
        parsedName: 'BAGELS',
        quantityReal: 6,
        quantityText: '6 EA',
        quantityUnit: 'ea',
        unitPriceMinor: null,
        totalPriceMinor: 600,
      },
    ],
  ];

  it.each(forms)('reads %s', (name, rowPrice, expected) => {
    const parsed = parseReceiptOcr(pricedReceipt(name, rowPrice));
    expect(parsed.lines[0]).toMatchObject(expected);
  });

  it('derives a unit price from a multi-buy row total', () => {
    const parsed = parseReceiptOcr(pricedReceipt('YOGURT 3 FOR 5.00', '5.00'));
    expect(parsed.lines[0]).toMatchObject({
      unitPriceMinor: 167,
      totalPriceMinor: 500,
    });
  });

  it('leaves a size-looking token in the name and the quantity fields empty', () => {
    const parsed = parseReceiptOcr(pricedReceipt('MILK 2% 1L', '3.49'));
    expect(parsed.lines[0]).toMatchObject({
      rawText: 'MILK 2% 1L',
      parsedName: 'MILK 2% 1L',
      quantityReal: null,
      quantityText: null,
      quantityUnit: null,
    });
  });
});

describe('parseReceiptOcr price columns', () => {
  it('reads a price only when it sits in the detected column', () => {
    const parsed = parseReceiptOcr(
      payload([
        { text: 'MILK', y: 100 },
        { text: '3.49', y: 100, x: 800 },
        { text: 'SOURDOUGH BREAD', y: 130 },
        { text: '4.99', y: 130, x: 800 },
        { text: 'OLD RECEIPT', y: 160 },
        { text: '21.00', y: 160, x: 300 },
        { text: 'SUBTOTAL', y: 200 },
        { text: '8.48', y: 200, x: 800 },
      ]),
    );

    const oldReceipt = parsed.lines.find(
      (row) => row.rawText === 'OLD RECEIPT 21.00',
    );
    expect(oldReceipt).toMatchObject({ isItemChunk: false });
    expect(parsed.warnings).not.toContain('no price column found');
  });

  it('falls back to reading prices line by line when no column stands out', () => {
    const parsed = parseReceiptOcr(
      payload([
        { text: 'MILK', y: 100 },
        { text: '3.49', y: 100, x: 300 },
        { text: 'SOURDOUGH', y: 130 },
        { text: '4.99', y: 130, x: 760 },
      ]),
    );

    expect(parsed.lines.map((row) => row.isItemChunk)).toEqual([true, true]);
    expect(parsed.warnings.join(' ')).toContain('no price column found');
    expect(parsed.warnings.join(' ')).toContain('no subtotal or total');
  });
});

describe('parseReceiptOcr totals, delta and no-loss', () => {
  it('computes the delta from the item totals and the subtotal', () => {
    const parsed = parseReceiptOcr(
      payload([
        { text: 'MILK', y: 100 },
        { text: '3.49', y: 100, x: 800 },
        { text: 'BREAD', y: 130 },
        { text: '5.00', y: 130, x: 800 },
        { text: 'SUBTOTAL', y: 180 },
        { text: '8.00', y: 180, x: 800 },
        { text: 'TOTAL', y: 200 },
        { text: '8.00', y: 200, x: 800 },
      ]),
    );

    expect(parsed.deltaMinor).toBe(49);
    expect(parsed.warnings.join(' ')).toContain('0.49');
    expect(deltaExceedsThreshold(5, 800)).toBe(false);
    expect(deltaExceedsThreshold(9, 800)).toBe(true);
    expect(deltaExceedsThreshold(30, 10000)).toBe(false);
    expect(deltaExceedsThreshold(101, 10000)).toBe(true);
  });

  it('stays quiet when the items add up to the subtotal', () => {
    const parsed = parseReceiptOcr(
      payload([
        { text: 'MILK', y: 100 },
        { text: '3.49', y: 100, x: 800 },
        { text: 'SUBTOTAL', y: 140 },
        { text: '3.49', y: 140, x: 800 },
        { text: 'TOTAL', y: 160 },
        { text: '3.49', y: 160, x: 800 },
      ]),
    );

    expect(parsed.deltaMinor).toBe(0);
    expect(parsed.warnings.join(' ')).not.toContain('item lines total');
  });

  it('accounts for every OCR line exactly once, across the fixture set', () => {
    const parsed = parseReceiptOcr(
      payload([
        { text: 'CORNER MARKET', y: 20 },
        { text: 'MILK 2% 1L', y: 100 },
        { text: '3.49', y: 100, x: 800 },
        { text: 'BLANK LINE', y: 115, conf: 0.1 },
        { text: 'SUBTOTAL', y: 140 },
        { text: '3.49', y: 140, x: 800 },
      ]),
    );

    const consumed = parsed.lines.flatMap((row) => row.sourceLineIndexes);
    expect([...consumed].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('reports how many OCR lines carried no text', () => {
    const parsed = parseReceiptOcr(
      payload([
        { text: '   ', y: 20, conf: 0.1 },
        { text: '', y: 40, conf: 0.1 },
        { text: 'MILK', y: 100 },
        { text: '3.49', y: 100, x: 800 },
      ]),
    );

    expect(parsed.lines).toHaveLength(1);
    expect(parsed.warnings.join(' ')).toContain('2 OCR lines carried no text');
  });

  it('returns an empty parse for a payload it cannot read', () => {
    expect(parseReceiptOcr('not json')).toMatchObject({
      lines: [],
      subtotalMinor: null,
      totalMinor: null,
      deltaMinor: null,
    });
    expect(parseReceiptOcr('{"pages":[]}').lines).toEqual([]);
  });
});
