import { describe, expect, it } from 'vitest';
import { parseReceiptOcr } from '../../src/lib/server/receipts/parser';

type Line = {
  text: string;
  y: number;
  x?: number;
  w?: number;
  h?: number;
  conf?: number;
};

/** A payload in the sidecar's §9 shape; names at x=40, prices near x=800. */
function payload(lines: Line[], blocks: unknown[] = []): string {
  return JSON.stringify({
    pages: [
      {
        lines: lines.map(({ text, y, x = 40, w, h = 14, conf = 0.95 }) => ({
          box: [x, y, x + (w ?? text.length * 9), y + h],
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

describe('parseReceiptOcr skewed rows', () => {
  it('pairs a footer amount with its label when the amount sits lower', () => {
    const parsed = parseReceiptOcr(
      payload([
        { text: 'MILK', y: 100 },
        { text: '3.49', y: 100, x: 800 },
        { text: 'SUBTOTAL', y: 180 },
        { text: '3.49', y: 198, x: 800 },
        { text: 'TAX', y: 220 },
        { text: '0.28', y: 240, x: 800 },
        { text: 'TIP', y: 260 },
        { text: '0.50', y: 282, x: 800 },
        { text: 'TOTAL', y: 300 },
        { text: '4.27', y: 325, x: 800 },
      ]),
    );

    expect(parsed.subtotalMinor).toBe(349);
    expect(parsed.taxMinor).toBe(28);
    expect(parsed.totalMinor).toBe(427);
    expect(parsed.lines.filter((row) => row.isItemChunk)).toHaveLength(1);
    expect(
      parsed.lines.find((row) => row.rawText === 'TIP')?.totalPriceMinor,
    ).toBe(50);
  });

  it('keeps increasing skew from pairing a tip amount with the total label', () => {
    const parsed = parseReceiptOcr(
      payload([
        { text: '1 Golden Bubble Milk Tea', y: 100 },
        { text: '7.20', y: 100, x: 800 },
        { text: 'Subtotal', y: 180 },
        { text: '29.10', y: 198, x: 800 },
        { text: 'Tax', y: 220 },
        { text: '3.79', y: 240, x: 800 },
        { text: 'Tip', y: 260 },
        { text: '4.93', y: 282, x: 800 },
        { text: 'Tota]', y: 300 },
        { text: '37.82', y: 330, x: 800 },
      ]),
    );

    expect(parsed.subtotalMinor).toBe(2910);
    expect(parsed.taxMinor).toBe(379);
    expect(parsed.totalMinor).toBe(3782);
    expect(parsed.deltaMinor).toBe(720 - 2910);
    expect(parsed.lines.find((row) => row.rawText === 'Tip')).toMatchObject({
      isItemChunk: false,
      totalPriceMinor: 493,
    });
  });
});

describe('parseReceiptOcr intermediate columns', () => {
  it('does not read a discount printed in an intermediate column as an item', () => {
    const parsed = parseReceiptOcr(
      payload([
        { text: 'DMC PEARL COTTON', y: 100 },
        { text: 'Reg 7.99 1.0 @ 2.99', y: 130, x: 300 },
        { text: '2.99', y: 130, x: 900 },
        { text: 'CPN GET ITM40%', y: 160 },
        { text: '1.20', y: 160, x: 500 },
        { text: 'SUBTOTAL', y: 200 },
        { text: '2.99', y: 200, x: 900 },
        { text: 'TOTAL', y: 220 },
        { text: '2.99', y: 220, x: 900 },
      ]),
    );

    const items = parsed.lines.filter((row) => row.isItemChunk);
    expect(items.map((row) => [row.rawText, row.totalPriceMinor])).toEqual([
      ['DMC PEARL COTTON', 299],
    ]);
    expect(
      parsed.lines.find((row) => row.rawText.startsWith('CPN GET ITM40%')),
    ).toMatchObject({ isItemChunk: false });
  });

  it('reads an item total that carries a tax flag', () => {
    const parsed = parseReceiptOcr(
      payload([
        { text: 'CANDY CORN', y: 100 },
        { text: '3.49 P', y: 100, x: 800 },
        { text: 'SUBTOTAL', y: 140 },
        { text: '3.49', y: 140, x: 800 },
      ]),
    );

    expect(parsed.lines[0]).toMatchObject({
      rawText: 'CANDY CORN',
      totalPriceMinor: 349,
    });
  });

  it('reads an item total printed in a regular-price line', () => {
    const parsed = parseReceiptOcr(
      payload([
        { text: 'MILK', y: 100 },
        { text: '1.00', y: 100, x: 800 },
        { text: 'DMC PEARL COTTON', y: 130 },
        { text: '00077540975327', y: 130, x: 500 },
        { text: 'Reg 2.99 1.0 1,79. L.79', y: 160 },
        { text: 'SUBTOTAL', y: 200 },
        { text: '2.79', y: 200, x: 800 },
      ]),
    );

    expect(
      parsed.lines
        .filter((row) => row.isItemChunk)
        .map((row) => [row.parsedName, row.totalPriceMinor]),
    ).toEqual([
      ['MILK', 100],
      ['DMC PEARL COTTON', 179],
    ]);
  });
});

describe('parseReceiptOcr printed amount repairs', () => {
  it('reads an amount OCR split with a space', () => {
    const parsed = parseReceiptOcr(
      payload([
        { text: 'MILK', y: 100 },
        { text: '84.83', y: 100, x: 800 },
        { text: 'TOTAL', y: 180 },
        { text: '86. 21', y: 180, x: 800 },
      ]),
    );

    expect(parsed.totalMinor).toBe(8621);
    expect(parsed.lines.find((row) => row.rawText === 'TOTAL')).toMatchObject({
      totalPriceMinor: 8621,
    });
  });
});

describe('parseReceiptOcr item names', () => {
  it('parks a department header instead of folding it into the next item', () => {
    const parsed = parseReceiptOcr(
      payload([
        { text: 'MILK', y: 100 },
        { text: '1.00', y: 100, x: 800 },
        { text: '22-DAIRY', y: 130 },
        { text: 'BUTTER', y: 160 },
        { text: '8.99', y: 160, x: 800 },
        { text: 'SUBTOTAL', y: 200 },
        { text: '9.99', y: 200, x: 800 },
      ]),
    );

    expect(
      parsed.lines.find((row) => row.rawText === '22-DAIRY'),
    ).toMatchObject({
      isItemChunk: false,
    });
    expect(
      parsed.lines.filter((row) => row.isItemChunk).map((row) => row.rawText),
    ).toEqual(['MILK', 'BUTTER']);
  });

  it('does not merge an unreadable item into the next item', () => {
    const parsed = parseReceiptOcr(
      payload([
        { text: 'MILK', y: 100 },
        { text: '1.00', y: 100, x: 800 },
        { text: 'CHEDDAR', y: 130 },
        { text: '§. 99', y: 130, x: 800 },
        { text: '27-PRODUCE', y: 160 },
        { text: 'CHIVES', y: 190 },
        { text: '3.29', y: 190, x: 800 },
        { text: 'SUBTOTAL', y: 230 },
        { text: '4.29', y: 230, x: 800 },
      ]),
    );

    expect(
      parsed.lines.filter((row) => row.isItemChunk).map((row) => row.rawText),
    ).toEqual(['MILK', 'CHIVES']);
    expect(parsed.warnings.join(' ')).toContain('could not read the amount');
  });

  it('keeps a pending item with an unreadable price separate from the next item', () => {
    const parsed = parseReceiptOcr(
      payload([
        { text: 'MILK', y: 100 },
        { text: '1.00', y: 100, x: 800 },
        { text: 'EDS PE FILL', y: 130 },
        { text: '20 86,99 1.3.98', y: 160 },
        { text: 'AVOCADO LIME', y: 190 },
        { text: '7.99', y: 190, x: 800 },
        { text: 'SUBTOTAL', y: 230 },
        { text: '8.99', y: 230, x: 800 },
      ]),
    );

    expect(
      parsed.lines
        .filter((row) => row.isItemChunk)
        .map((row) => [row.parsedName, row.totalPriceMinor]),
    ).toEqual([
      ['MILK', 100],
      ['EDS PE FILL', null],
      ['AVOCADO LIME', 799],
    ]);
  });

  it('keeps an item with a product code and unreadable price separate', () => {
    const parsed = parseReceiptOcr(
      payload([
        { text: 'MILK', y: 100 },
        { text: '1.00', y: 100, x: 800 },
        { text: '06030300143 PC CHIVES 769. 329', y: 130 },
        { text: '4070 CELERY STALKS', y: 160 },
        { text: '3.50', y: 160, x: 800 },
        { text: 'SUBTOTAL', y: 200 },
        { text: '4.50', y: 200, x: 800 },
      ]),
    );

    expect(
      parsed.lines
        .filter((row) => row.isItemChunk)
        .map((row) => [row.parsedName, row.totalPriceMinor]),
    ).toEqual([
      ['MILK', 100],
      ['PC CHIVES', null],
      ['4070 CELERY STALKS', 350],
    ]);
  });
});

describe('parseReceiptOcr footer noise', () => {
  it('keeps receipt-number and ordered lines out of the first item', () => {
    const parsed = parseReceiptOcr(
      payload([
        { text: 'Check #97', y: 100 },
        { text: 'Ordered: 2026-10-18 6:42 p.m.', y: 130 },
        { text: '1 Golden Bubble Milk Tea', y: 160 },
        { text: '7.20', y: 160, x: 800 },
        { text: 'Subtotal', y: 200 },
        { text: '7.20', y: 200, x: 800 },
        { text: 'Tax', y: 220 },
        { text: '0.94', y: 220, x: 800 },
        { text: 'Total', y: 240 },
        { text: '8.14', y: 240, x: 800 },
      ]),
    );

    expect(
      parsed.lines
        .filter((row) => row.isItemChunk)
        .map((row) => [row.parsedName, row.totalPriceMinor]),
    ).toEqual([['1 Golden Bubble Milk Tea', 720]]);
    expect(
      parsed.lines.find((row) => row.rawText === 'Check #97'),
    ).toMatchObject({ isItemChunk: false });
  });

  it('keeps payment metadata after the total out of the items', () => {
    const parsed = parseReceiptOcr(
      payload([
        { text: 'MILK', y: 100 },
        { text: '3.49', y: 100, x: 800 },
        { text: 'SUBTOTAL', y: 140 },
        { text: '3.49', y: 140, x: 800 },
        { text: 'TOTAL', y: 160 },
        { text: '3.49', y: 160, x: 800 },
        { text: 'Transaction Type', y: 180 },
        { text: 'Payment', y: 200 },
        { text: '068742', y: 200, x: 800 },
      ]),
    );

    expect(
      parsed.lines.filter((row) => row.isItemChunk).map((row) => row.rawText),
    ).toEqual(['MILK']);
  });
});

describe('parseReceiptOcr tax inference', () => {
  it('reclassifies a garbled tax row between subtotal and total', () => {
    const parsed = parseReceiptOcr(
      payload([
        { text: 'MILK', y: 100 },
        { text: '20.00', y: 100, x: 800 },
        { text: 'SUBTOTAL', y: 140 },
        { text: '20.00', y: 140, x: 800 },
        { text: 'cuaтorat', y: 160 },
        { text: '2.60', y: 160, x: 800 },
        { text: 'TOTAL', y: 180 },
        { text: '22.60', y: 180, x: 800 },
      ]),
    );

    expect(parsed.taxMinor).toBe(260);
    expect(parsed.totalMinor).toBe(2260);
    expect(parsed.lines.filter((row) => row.isItemChunk)).toHaveLength(1);
    expect(
      parsed.lines.find((row) => row.rawText === 'cuaтorat'),
    ).toMatchObject({ isItemChunk: false, totalPriceMinor: 260 });
  });
});
