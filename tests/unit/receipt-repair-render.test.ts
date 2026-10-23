import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import ReceiptItemPicker from '../../src/lib/components/receipts/ReceiptItemPicker.svelte';
import ReceiptLines from '../../src/lib/components/receipts/ReceiptLines.svelte';
import ReceiptReviewEditor from '../../src/lib/components/receipts/ReceiptReviewEditor.svelte';
import type {
  ReceiptDetail,
  ReceiptDetailLine,
  ReceiptSuggestion,
} from '../../src/lib/shared/schemas';

/**
 * The repair surface as the reviewer meets it (ticket 16): a committed receipt
 * offers an explicit repair *mode*, entered through a two-tap confirm, and only
 * while it is on do the item rows grow binding-only controls. The raw artifacts
 * are frozen throughout — no printed-text field, no draft, no release.
 */

const ITEM_ID = '00000000-0000-4000-8000-0000000000aa';
const NEW_ITEM_ID = '00000000-0000-4000-8000-0000000000bb';
const RECEIPT_ID = '00000000-0000-4000-8000-0000000000cc';

const catalogItems = [
  { id: ITEM_ID, name: 'Sourdough Loaf' },
  { id: NEW_ITEM_ID, name: 'Rye Loaf' },
];
const groups = [
  {
    id: '00000000-0000-4000-8000-0000000000ee',
    name: 'Corner Market',
    kind: 'store' as const,
  },
];

/** Svelte's hydration markers and scoped-class hashes are noise for assertions. */
function readable(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/gu, '').replace(/ svelte-\w+/gu, '');
}

/** Each rendered `<button>` element as a string, so a named one can be read. */
function buttons(body: string): string[] {
  return body
    .split('<button')
    .slice(1)
    .map((part) => part.split('</button>')[0] ?? '');
}

const SUGGESTION: ReceiptSuggestion = {
  catalogItemId: NEW_ITEM_ID,
  name: 'Rye Loaf',
  tier: 2,
  score: 0.88,
  sameStore: false,
};

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
    catalogItemId: ITEM_ID,
    reviewState: 'bound',
    boundVia: 'manual',
    boundRank: null,
    suggestions: [],
    ...overrides,
  };
}

const PARKED_LINE = line({
  id: '00000000-0000-4000-8000-0000000000ff',
  lineIndex: 1,
  rawText: 'SUBTOTAL',
  parsedName: null,
  isItemChunk: false,
  catalogItemId: null,
  reviewState: 'unreviewed',
});

function detail(overrides: Partial<ReceiptDetail> = {}): ReceiptDetail {
  const base: ReceiptDetail = {
    id: RECEIPT_ID,
    status: 'committed',
    createdAt: '2026-10-17T12:00:00.000Z',
    capturedAt: null,
    processedAt: null,
    parseVersion: 1,
    attempts: 1,
    ocrWarnings: null,
    parseQuality: null,
    updatedAt: '2026-10-17T12:05:00.000Z',
    committedAt: '2026-10-17T12:05:00.000Z',
    currency: 'USD',
    subtotalMinor: 499,
    taxMinor: null,
    totalMinor: 499,
    storeGroupId: groups[0]!.id,
    imageAvailable: true,
    hasUnknowns: false,
    lastError: null,
    ocrText: 'SOURDOUGH BREAD',
    lines: [line(), PARKED_LINE],
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

function renderLines(
  lines: ReceiptDetailLine[],
  props: Record<string, unknown> = {},
): string {
  return readable(
    render(ReceiptLines, {
      props: { lines, currency: 'USD', catalogItems, ...props },
    }).body,
  );
}

describe('ReceiptReviewEditor — repair mode', () => {
  it('offers repair on a committed receipt, and asks again before entering it', () => {
    const body = renderEditor(detail());

    expect(body).toContain('>Repair binding</button>');
    // One tap only arms the confirm: the mode is not on yet.
    expect(body).not.toContain('Start repair');
    expect(body).not.toContain('Repairing the binding');
    // A committed receipt offers neither of the review write path's actions.
    expect(body).not.toContain('Commit receipt');
    expect(body).not.toContain('Discard receipt');
  });

  it('offers no repair when the page cannot write', () => {
    expect(renderEditor(detail(), false)).not.toContain('Repair binding');
  });

  it('offers no repair while the receipt is still in review', () => {
    const body = renderEditor(
      detail({ status: 'review', committedAt: null, lines: [line()] }),
    );

    expect(body).not.toContain('Repair binding');
  });

  it('offers no repair when the receipt holds no item line to correct', () => {
    const body = renderEditor(detail({ lines: [PARKED_LINE] }));

    expect(body).not.toContain('Repair binding');
  });
});

describe('ReceiptLines — repair mode', () => {
  it('frees the binding controls and freezes the raw artifacts', () => {
    const body = renderLines([line()], {
      repairing: true,
      onRepairState: () => {},
      onRepairBind: () => {},
    });

    // The binding is the reviewer's to move…
    expect(body).toContain('aria-label="Repair state"');
    expect(body).toContain('aria-label="Find item"');
    // …the printed text is shown, never editable, and nothing is created.
    expect(body).toContain('line-printed">SOURDOUGH BREAD<');
    expect(body).not.toContain('input.line-printed');
    expect(body).not.toContain('Create new item');
    expect(body).not.toContain('>Release</button>');
  });

  it('makes the state the line already holds inert, so a repair never releases it', () => {
    const unknown = renderLines(
      [line({ reviewState: 'unknown', catalogItemId: null })],
      {
        repairing: true,
        onRepairState: () => {},
        onRepairBind: () => {},
      },
    );

    const cantIdentify = buttons(unknown).find((button) =>
      button.includes("Can't identify"),
    );
    const skip = buttons(unknown).find((button) => button.includes('Skip'));
    expect(cantIdentify).toContain('disabled');
    expect(skip).not.toContain('disabled');
  });

  it('keeps the chip the line sits on inert, and frees the others', () => {
    const body = renderLines([line({ suggestions: [SUGGESTION] })], {
      repairing: true,
      onRepairState: () => {},
      onRepairSuggestion: () => {},
      onRepairBind: () => {},
    });

    expect(
      buttons(body).find((button) => button.includes('Rye Loaf')),
    ).not.toContain('disabled');

    const bound = renderLines(
      [line({ catalogItemId: NEW_ITEM_ID, suggestions: [SUGGESTION] })],
      {
        repairing: true,
        onRepairState: () => {},
        onRepairSuggestion: () => {},
        onRepairBind: () => {},
      },
    );
    expect(
      buttons(bound).find((button) => button.includes('Rye Loaf')),
    ).toContain('disabled');
  });

  it('leaves a parked row alone even in repair mode', () => {
    const body = renderLines([PARKED_LINE], {
      repairing: true,
      onRepairState: () => {},
      onRepairBind: () => {},
    });

    expect(body).not.toContain('aria-label="Repair state"');
    expect(body).not.toContain('aria-label="Find item"');
  });
});

describe('ReceiptItemPicker — repair mode', () => {
  function renderPicker(props: Record<string, unknown> = {}): string {
    return readable(
      render(ReceiptItemPicker, {
        props: {
          line: line(),
          catalogItems,
          repairing: true,
          onBind: () => {},
          ...props,
        },
      }).body,
    );
  }

  it('always searches, names the current item, and offers neither a draft nor a release', () => {
    const body = renderPicker();

    expect(body).toContain('aria-label="Find item"');
    expect(body).toMatch(/binding-item[^>]*>Sourdough Loaf</u);
    expect(body).not.toContain('Create new item');
    expect(body).not.toContain('>Release</button>');
  });

  it('offers the search alone on a line with no item to name', () => {
    const body = renderPicker({
      line: line({ reviewState: 'unknown', catalogItemId: null }),
    });

    expect(body).toContain('aria-label="Find item"');
    expect(body).not.toContain('binding-item');
  });
});
