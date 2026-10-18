import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import ReceiptLines from '../../src/lib/components/receipts/ReceiptLines.svelte';
import ReceiptTotalsStrip from '../../src/lib/components/receipts/ReceiptTotalsStrip.svelte';
import type { ReceiptLine } from '../../src/lib/shared/schemas';
import { parseReceiptOcr } from '../../src/lib/server/receipts/parser';

/**
 * The receipt detail's two rendering pieces, server-rendered from the committed
 * fixtures — the same input the API hands the browser. Money is asserted by its
 * digits so the test does not depend on the machine's locale.
 */

function fixture(name: string) {
  return parseReceiptOcr(
    readFileSync(
      resolve(process.cwd(), `tests/fixtures/receipts/${name}.json`),
      'utf8',
    ),
  );
}

/** The parser's lines in the shape the detail API returns them. */
function linesOf(name: string): ReceiptLine[] {
  return fixture(name).lines.map((line, lineIndex) => ({
    id: `00000000-0000-4000-8000-${String(lineIndex).padStart(12, '0')}`,
    lineIndex,
    rawText: line.rawText,
    parsedName: line.parsedName,
    quantityReal: line.quantityReal,
    quantityText: line.quantityText,
    quantityUnit: line.quantityUnit,
    unitPriceMinor: line.unitPriceMinor,
    totalPriceMinor: line.totalPriceMinor,
    isItemChunk: line.isItemChunk,
    confidence: line.confidence,
    catalogItemId: null,
    reviewState: 'unreviewed' as const,
    boundVia: null,
    boundRank: null,
  }));
}

/** Svelte's hydration markers and scoped-class hashes are noise for assertions. */
function readable(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/gu, '').replace(/ svelte-\w+/gu, '');
}

function renderLines(name: string): string {
  return readable(
    render(ReceiptLines, { props: { lines: linesOf(name), currency: 'USD' } })
      .body,
  );
}

function renderStrip(name: string): string {
  const parsed = fixture(name);
  return readable(
    render(ReceiptTotalsStrip, {
      props: {
        lines: linesOf(name),
        subtotalMinor: parsed.subtotalMinor,
        taxMinor: parsed.taxMinor,
        totalMinor: parsed.totalMinor,
        currency: 'USD',
      },
    }).body,
  );
}

/** The rendered row that carries this printed text. */
function rowFor(body: string, printedText: string): string {
  const row = body
    .split('<li')
    .find((candidate) => candidate.includes(`>${printedText}<`));
  expect(row, `no row rendered for ${printedText}`).toBeDefined();
  return row!;
}

describe('ReceiptLines', () => {
  it('renders every parsed row of the fixture, parked rows included', () => {
    const parsed = fixture('clean-grocery');
    const body = renderLines('clean-grocery');

    expect(body.match(/<li class="receipt-line/gu)).toHaveLength(
      parsed.lines.length,
    );
    // Nothing is dropped between the parse and the screen.
    for (const line of parsed.lines) {
      expect(body).toContain(line.rawText);
    }
  });

  it('shows the parsed name, quantity, unit price and total price on an item line', () => {
    const row = rowFor(renderLines('clean-grocery'), 'CUCUMBERS 2 @ 1.50');

    expect(row).toContain('line-parsed-name">CUCUMBERS');
    expect(row).toContain('line-quantity">2 ea');
    expect(row).toMatch(/line-unit-price[^>]*>.*1\.50\/ea/u);
    expect(row).toMatch(/line-total-price[^>]*>.*3\.00/u);
  });

  it('shows a scale weight and its per-pound price', () => {
    const row = rowFor(
      renderLines('clean-grocery'),
      'BANANAS 2.15LB @ 0.59/LB',
    );

    expect(row).toContain('line-parsed-name">BANANAS');
    expect(row).toContain('line-quantity">2.15 lb');
    expect(row).toMatch(/line-unit-price[^>]*>.*0\.59\/lb/u);
    expect(row).toMatch(/line-total-price[^>]*>.*1\.27/u);
  });

  it('shows the amount on a line that carries no quantity', () => {
    const row = rowFor(renderLines('clean-grocery'), 'MILK 2% 1L');

    expect(row).toContain('line-parsed-name">MILK 2% 1L');
    expect(row).toMatch(/line-total-price[^>]*>.*3\.49/u);
    expect(row).not.toContain('line-quantity');
    expect(row).not.toContain('parked');
  });

  it('shows the parsed name on every item row of the fixture', () => {
    const body = renderLines('clean-grocery');
    const itemRows = fixture('clean-grocery').lines.filter(
      (line) => line.isItemChunk,
    );

    expect(body.match(/class="line-parsed-name"/gu)).toHaveLength(
      itemRows.length,
    );
  });

  it('marks parked rows as parked and keeps their printed text and amount', () => {
    const body = renderLines('coupons-negatives');

    const subtotal = rowFor(body, 'SUBTOTAL');
    expect(subtotal).toContain('class="receipt-line parked"');
    expect(subtotal).toContain('line-parked">Parked');
    expect(subtotal).toMatch(/line-total-price[^>]*>.*25\.64/u);

    // The coupon adjustments are parked rows, and they keep their sign.
    const coupon = rowFor(body, 'STORE COUPON');
    expect(coupon).toContain('line-parked">Parked');
    expect(coupon).toMatch(/line-total-price[^>]*>[^<]*-[^<]*1\.50/u);

    const parkedRows = body.match(/class="receipt-line parked"/gu) ?? [];
    const parkedLines = fixture('coupons-negatives').lines.filter(
      (line) => !line.isItemChunk,
    );
    expect(parkedRows).toHaveLength(parkedLines.length);
  });

  it('renders nothing at all for a receipt with no lines', () => {
    const body = readable(
      render(ReceiptLines, { props: { lines: [], currency: 'USD' } }).body,
    );

    expect(body.trim()).not.toContain('receipt-line');
  });
});

describe('ReceiptTotalsStrip', () => {
  it('shows the item sum, subtotal, tax and total of the fixture', () => {
    const body = renderStrip('clean-grocery');

    expect(body).toMatch(/totals-items[^>]*>.*39\.49/u);
    expect(body).toMatch(/totals-subtotal[^>]*>.*39\.49/u);
    expect(body).toMatch(/totals-tax[^>]*>.*2\.47/u);
    expect(body).toMatch(/totals-total[^>]*>.*41\.96/u);
  });

  it('stays silent when the item lines add up', () => {
    expect(renderStrip('clean-grocery')).not.toContain('totals-warning');
    expect(renderStrip('stub-ocr')).not.toContain('totals-warning');
  });

  it('warns above the threshold, naming the sum, the subtotal and the difference', () => {
    const body = renderStrip('coupons-negatives');

    expect(body).toContain('totals-warning');
    expect(body).toContain('27.94');
    expect(body).toContain('25.64');
    expect(body).toContain('2.30');
  });

  it('shows dashes, not guesses, when the receipt prints no totals', () => {
    const body = renderStrip('washed-out');

    expect(body).toMatch(/totals-subtotal[^>]*>.*—/u);
    expect(body).toMatch(/totals-total[^>]*>.*—/u);
    expect(body).not.toContain('totals-warning');
  });

  it('renders nothing when there is nothing to reconcile', () => {
    const body = readable(
      render(ReceiptTotalsStrip, {
        props: {
          lines: [],
          subtotalMinor: null,
          taxMinor: null,
          totalMinor: null,
          currency: 'USD',
        },
      }).body,
    );

    expect(body.trim()).not.toContain('totals-strip');
  });
});
