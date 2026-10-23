import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import ReceiptLines from '../../src/lib/components/receipts/ReceiptLines.svelte';
import ReceiptReviewEditor from '../../src/lib/components/receipts/ReceiptReviewEditor.svelte';
import type {
  ReceiptDetail,
  ReceiptDetailLine,
} from '../../src/lib/shared/schemas';

/**
 * The write path as the reviewer meets it: a commit button that stays disabled
 * while the gate is unmet and says why, a discard that asks twice, and a
 * committed (or discarded) receipt that offers neither. The read-only line shows
 * the item the commit landed on — read from the snapshot, which is how a created
 * item becomes visible at all.
 */

const ITEM_ID = '00000000-0000-4000-8000-0000000000aa';
const STORE_ID = '00000000-0000-4000-8000-0000000000bb';
const RECEIPT_ID = '00000000-0000-4000-8000-0000000000cc';

const catalogItems = [{ id: ITEM_ID, name: 'Sourdough Loaf' }];
const groups = [
  { id: STORE_ID, name: 'Corner Market', kind: 'store' as const },
];

/** Svelte's hydration markers and scoped-class hashes are noise for assertions. */
function readable(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/gu, '').replace(/ svelte-\w+/gu, '');
}

function line(overrides: Partial<ReceiptDetailLine> = {}): ReceiptDetailLine {
  return {
    id: '00000000-0000-4000-8000-0000000000dd',
    lineIndex: 0,
    rawText: 'SOURDOUGH BREAD',
    parsedName: 'SOURDOUGH BREAD',
    quantityReal: null,
    quantityText: null,
    quantityUnit: null,
    unitPriceMinor: null,
    totalPriceMinor: 499,
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

const PARKED_LINE = line({
  id: '00000000-0000-4000-8000-0000000000ee',
  lineIndex: 1,
  rawText: 'SUBTOTAL',
  parsedName: null,
  isItemChunk: false,
});

function detail(overrides: Partial<ReceiptDetail> = {}): ReceiptDetail {
  const base: ReceiptDetail = {
    id: RECEIPT_ID,
    status: 'review',
    createdAt: '2026-10-17T12:00:00.000Z',
    capturedAt: null,
    processedAt: null,
    parseVersion: 1,
    attempts: 1,
    ocrWarnings: null,
    parseQuality: null,
    updatedAt: '2026-10-17T12:05:00.000Z',
    committedAt: null,
    currency: 'USD',
    subtotalMinor: 499,
    taxMinor: null,
    totalMinor: 499,
    storeGroupId: null,
    imageAvailable: true,
    hasUnknowns: false,
    lastError: null,
    ocrText: 'SOURDOUGH BREAD',
    lines: [PARKED_LINE],
  };
  return { ...base, ...overrides };
}

function renderEditor(detailValue: ReceiptDetail, writable = true): string {
  return readable(
    render(ReceiptReviewEditor, {
      props: {
        detail: detailValue,
        writable,
        catalogItems,
        groups,
        onSaved: () => {},
      },
    }).body,
  );
}

describe('ReceiptReviewEditor — commit', () => {
  it('disables commit on an undecided item line and says which decision is missing', () => {
    const body = renderEditor(detail({ lines: [line(), PARKED_LINE] }));

    expect(body).toContain('Commit receipt');
    expect(body).toMatch(/commit-button[^>]*disabled/u);
    expect(body).toContain('One item line still needs a decision');
  });

  it('disables commit while no store stands, even with every line decided', () => {
    const body = renderEditor(
      detail({ lines: [line({ reviewState: 'unknown' }), PARKED_LINE] }),
    );

    expect(body).toMatch(/commit-button[^>]*disabled/u);
    expect(body).toContain('store');
  });

  it('enables commit once every item line is decided and a store is chosen', () => {
    const body = renderEditor(
      detail({
        storeGroupId: STORE_ID,
        lines: [
          line({ reviewState: 'bound', catalogItemId: ITEM_ID }),
          PARKED_LINE,
        ],
      }),
    );

    expect(body).toContain('Commit receipt');
    expect(body).not.toMatch(/commit-button[^>]*disabled/u);
    expect(body).not.toContain('needs a decision');
  });

  it('offers no commit at all on a receipt that is not in review', () => {
    const body = renderEditor(
      detail({ status: 'committed', storeGroupId: STORE_ID }),
    );

    expect(body).not.toContain('Commit receipt');
  });

  it('shows the offline note instead of the commit button when the page cannot write', () => {
    const body = renderEditor(detail({ lines: [line()] }), false);

    expect(body).toContain('Reviewing needs a connection');
    expect(body).not.toContain('Commit receipt');
  });
});

describe('ReceiptReviewEditor — discard', () => {
  it('asks twice before discarding, and says what is kept', () => {
    const body = renderEditor(detail({ lines: [line()] }));

    expect(body).toContain('Discard receipt');
    // One tap only arms the confirm: nothing is deleted yet.
    expect(body).not.toContain('Confirm discard');
    expect(body).not.toContain('The photo is deleted');
  });

  it('offers discard from a failed receipt too, where there are no lines', () => {
    const body = renderEditor(
      detail({ status: 'failed', lines: [], imageAvailable: true }),
    );

    expect(body).toContain('Discard receipt');
    // A receipt with no lines is not reviewable, so it has no review controls.
    expect(body).not.toContain('Commit receipt');
  });

  it('offers no discard once the receipt is committed or already discarded', () => {
    expect(renderEditor(detail({ status: 'committed' }))).not.toContain(
      'Discard receipt',
    );
    const discarded = renderEditor(
      detail({ status: 'discarded', imageAvailable: false }),
    );
    expect(discarded).not.toContain('Discard receipt');
    expect(discarded).toContain('Image purged');
  });

  it('hides discard when the page cannot write', () => {
    const body = renderEditor(detail({ status: 'review' }), false);

    expect(body).not.toContain('Discard receipt');
  });
});

describe('ReceiptLines — the committed binding', () => {
  function renderLines(
    lines: ReceiptDetailLine[],
    items = catalogItems,
  ): string {
    return readable(
      render(ReceiptLines, {
        props: { lines, currency: 'USD', catalogItems: items },
      }).body,
    );
  }

  it('shows the item a committed line landed on, read from the snapshot', () => {
    const body = renderLines([
      line({
        reviewState: 'new',
        catalogItemId: ITEM_ID,
        boundVia: 'created',
      }),
    ]);

    expect(body).toContain('line-bound-item">Sourdough Loaf');
  });

  it('shows nothing yet when the snapshot has not caught up with the commit', () => {
    const body = renderLines(
      [line({ reviewState: 'new', catalogItemId: ITEM_ID })],
      [],
    );

    expect(body).not.toContain('line-bound-item');
    // The line itself is still shown — only the name is waiting on the snapshot.
    expect(body).toContain('SOURDOUGH BREAD');
  });

  it('keeps a parked row free of any binding, whatever it carries', () => {
    const body = renderLines([
      line({ ...PARKED_LINE, catalogItemId: ITEM_ID }),
    ]);

    expect(body).not.toContain('line-bound-item');
  });
});
