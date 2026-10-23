import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import ReceiptItemPicker from '../../src/lib/components/receipts/ReceiptItemPicker.svelte';
import ReceiptStorePicker from '../../src/lib/components/receipts/ReceiptStorePicker.svelte';
import type { ReceiptDetailLine } from '../../src/lib/shared/schemas';

/**
 * The two pickers the review editor adds on top of the line editor, rendered
 * from explicit props: the per-line item search with its inline draft, and the
 * receipt's store picker with its prefill, required state and inline draft.
 * What a tap then *means* is `receipt-binding.ts`; here the states are visible
 * on screen.
 */

const ITEM_ID = '00000000-0000-4000-8000-0000000000aa';
const STORE_ID = '00000000-0000-4000-8000-0000000000bb';

/** Svelte's hydration markers and scoped-class hashes are noise for assertions. */
function readable(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/gu, '').replace(/ svelte-\w+/gu, '');
}

function line(overrides: Partial<ReceiptDetailLine> = {}): ReceiptDetailLine {
  return {
    id: '00000000-0000-4000-8000-0000000000cc',
    lineIndex: 4,
    rawText: 'MILK 2% 1L',
    parsedName: 'MILK 2% 1L',
    quantityReal: null,
    quantityText: null,
    quantityUnit: null,
    unitPriceMinor: null,
    totalPriceMinor: 349,
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

const catalogItems = [
  { id: ITEM_ID, name: 'Milk' },
  { id: '00000000-0000-4000-8000-0000000000dd', name: 'Sourdough Bread' },
];

function renderPicker(props: Record<string, unknown>): string {
  return readable(
    render(ReceiptItemPicker, {
      props: {
        line: line(),
        catalogItems,
        onBind: () => {},
        onDraft: () => {},
        onDraftName: () => {},
        onRelease: () => {},
        ...props,
      },
    }).body,
  );
}

describe('ReceiptItemPicker', () => {
  it('offers a search box and an inline create on a line with no decision', () => {
    const body = renderPicker({});

    expect(body).toContain('aria-label="Find item"');
    expect(body).toContain('Create new item');
    // Nothing is bound yet, and an empty search offers no candidates.
    expect(body).not.toContain('match-button');
    expect(body).not.toContain('Release');
  });

  it('prefigures the top candidate in the search, unbound and one tap away', () => {
    const withChips = line({
      suggestions: [
        {
          catalogItemId: ITEM_ID,
          name: 'Milk',
          tier: 2,
          score: 0.92,
          sameStore: false,
        },
      ],
    });
    const body = renderPicker({ line: withChips });

    expect(body).toContain('value="Milk"');
    expect(body).toContain('match-button');
    // Prefilled, never bound: the line is still a decision to make.
    expect(body).not.toContain('binding-item');
  });

  it('leaves the search empty on a line the reviewer already decided', () => {
    const body = renderPicker({
      line: line({
        reviewState: 'skipped',
        suggestions: [
          {
            catalogItemId: ITEM_ID,
            name: 'Milk',
            tier: 2,
            score: 0.92,
            sameStore: false,
          },
        ],
      }),
    });

    expect(body).toContain('value=""');
    expect(body).not.toContain('match-button');
  });

  it('names the item a bound line sits on and offers to release it', () => {
    const body = renderPicker({
      line: line({
        reviewState: 'bound',
        catalogItemId: ITEM_ID,
        boundVia: 'suggested',
        boundRank: 1,
      }),
    });

    expect(body).toContain('binding-item">Milk<');
    expect(body).toContain('>Release</button>');
    expect(body).not.toContain('aria-label="Find item"');
  });

  it('shows the draft name once one exists, and the parser’s name before that', () => {
    const drafting = line({ reviewState: 'new' });

    expect(renderPicker({ line: drafting })).toContain(
      'aria-label="New item name"',
    );
    // The plan's rule: "create new item" fills parsed_name as the initial name.
    expect(renderPicker({ line: drafting })).toContain('value="MILK 2% 1L"');
    expect(
      renderPicker({ line: drafting, draftName: 'Sourdough loaf' }),
    ).toContain('value="Sourdough loaf"');
    expect(renderPicker({ line: drafting })).toContain(
      '>Remove draft</button>',
    );
  });
});

function renderStore(props: Record<string, unknown>): string {
  return readable(
    render(ReceiptStorePicker, {
      props: {
        stores: [{ id: STORE_ID, name: 'Corner Market', kind: 'store' }],
        onChoose: () => {},
        onDraft: () => {},
        onClearDraft: () => {},
        ...props,
      },
    }).body,
  );
}

describe('ReceiptStorePicker', () => {
  it('shows the required state and the prefilled best match before a choice', () => {
    const body = renderStore({
      editable: true,
      prefill: { id: STORE_ID, name: 'Corner Market', kind: 'store' },
    });

    expect(body).toContain('store-required');
    expect(body).toContain('Store required before commit.');
    expect(body).toContain('Looks like <strong>Corner Market</strong>');
    expect(body).toContain('>Use Corner Market</button>');
    expect(body).toContain('>Create new store</button>');
    expect(body).toContain('aria-required="true"');
  });

  it('drops the required state once a store is chosen', () => {
    const body = renderStore({ editable: true, storeGroupId: STORE_ID });

    expect(body).not.toContain('store-required');
    expect(body).toContain('value="' + STORE_ID + '"');
  });

  it('carries an inline draft as the chosen store, without a group row', () => {
    const body = renderStore({ editable: true, draftName: 'Trader Joe’s' });

    expect(body).not.toContain('store-required');
    expect(body).toContain('New store: Trader Joe’s (draft)');
    expect(body).toContain('>Remove draft store</button>');
    expect(body).not.toContain('>Create new store</button>');
  });

  it('renders the store read-only when the receipt is not editable', () => {
    expect(renderStore({ storeGroupId: STORE_ID })).toContain(
      'store-readonly">Corner Market<',
    );
    expect(renderStore({})).toContain('store-readonly">No store<');
  });
});
