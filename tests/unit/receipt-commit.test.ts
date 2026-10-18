import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/lib/client/api';
import {
  commitBlocker,
  commitErrorMessage,
  commitItemDrafts,
  commitReceiptInput,
  discardErrorMessage,
} from '../../src/lib/client/receipt-commit';
import type {
  ReceiptDetail,
  ReceiptDetailLine,
} from '../../src/lib/shared/schemas';

/**
 * What the editor sends when the reviewer commits, and what it says when the
 * server refuses. The gate is the server's to enforce; these are the sentences
 * and the payload that stand in front of it.
 */

const ITEM_ID = '00000000-0000-4000-8000-0000000000aa';
const STORE_ID = '00000000-0000-4000-8000-0000000000bb';
const RECEIPT_ID = '00000000-0000-4000-8000-0000000000cc';

function line(overrides: Partial<ReceiptDetailLine> = {}): ReceiptDetailLine {
  return {
    id: '00000000-0000-4000-8000-0000000000dd',
    lineIndex: 0,
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

const PARKED_LINE = line({
  id: '00000000-0000-4000-8000-0000000000ee',
  lineIndex: 1,
  rawText: 'SUBTOTAL',
  parsedName: null,
  isItemChunk: false,
  reviewState: 'unreviewed',
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
    updatedAt: '2026-10-17T12:05:00.000Z',
    committedAt: null,
    currency: 'USD',
    subtotalMinor: 349,
    taxMinor: null,
    totalMinor: 349,
    storeGroupId: null,
    imageAvailable: true,
    hasUnknowns: false,
    lastError: null,
    ocrText: 'MILK 2% 1L',
    lines: [],
  };
  return { ...base, ...overrides };
}

const NO_DRAFTS = { itemDrafts: {}, storeDraft: '' };

describe('commitBlocker', () => {
  it('lets a receipt with every item line decided and a store through', () => {
    const ready = detail({
      storeGroupId: STORE_ID,
      lines: [
        line({ reviewState: 'bound', catalogItemId: ITEM_ID }),
        PARKED_LINE,
      ],
    });

    expect(commitBlocker(ready, NO_DRAFTS)).toBeNull();
  });

  it('names an undecided item line, and counts several of them', () => {
    const one = detail({
      storeGroupId: STORE_ID,
      lines: [line(), PARKED_LINE],
    });
    expect(commitBlocker(one, NO_DRAFTS)).toContain('One item line');

    // A parked row is parser-settled: it never counts, however many there are.
    const several = detail({
      storeGroupId: STORE_ID,
      lines: [line(), line({ id: 'a' }), PARKED_LINE],
    });
    expect(commitBlocker(several, NO_DRAFTS)).toContain('2 item lines');
  });

  it('asks for a store when neither a group nor a draft stands', () => {
    const decided = detail({
      lines: [line({ reviewState: 'unknown' })],
    });

    expect(commitBlocker(decided, NO_DRAFTS)).toContain('store');
    expect(
      commitBlocker(decided, { itemDrafts: {}, storeDraft: '  ' }),
    ).toContain('store');
    expect(
      commitBlocker(decided, { itemDrafts: {}, storeDraft: 'Corner Market' }),
    ).toBeNull();
  });

  it('blocks a receipt that is no longer in review', () => {
    const committed = detail({ status: 'committed', storeGroupId: STORE_ID });

    expect(commitBlocker(committed, NO_DRAFTS)).toContain('review');
  });
});

describe('commitItemDrafts', () => {
  it('names only the lines that are creating an item', () => {
    const lines = [
      line({ id: 'new-line', reviewState: 'new' }),
      line({ id: 'bound-line', reviewState: 'bound', catalogItemId: ITEM_ID }),
      line({ id: 'unknown-line', reviewState: 'unknown' }),
      PARKED_LINE,
    ];

    expect(commitItemDrafts(lines, { 'new-line': 'Sourdough loaf' })).toEqual([
      { lineId: 'new-line', name: 'Sourdough loaf' },
    ]);
  });

  it('falls back to the name the picker showed when the reviewer never typed one', () => {
    const lines = [
      line({
        id: 'new-line',
        reviewState: 'new',
        parsedName: 'SOURDOUGH BREAD',
      }),
    ];

    // A trimmed name wins; an emptied or untouched field keeps the draft naming
    // something, exactly as the picker's field does.
    expect(
      commitItemDrafts(lines, { 'new-line': '  Sourdough loaf  ' }),
    ).toEqual([{ lineId: 'new-line', name: 'Sourdough loaf' }]);
    expect(commitItemDrafts(lines, { 'new-line': '   ' })).toEqual([
      { lineId: 'new-line', name: 'SOURDOUGH BREAD' },
    ]);
    expect(commitItemDrafts(lines, {})).toEqual([
      { lineId: 'new-line', name: 'SOURDOUGH BREAD' },
    ]);
  });

  it('skips a line with nothing to name it at all', () => {
    const nameless = line({
      id: 'new-line',
      reviewState: 'new',
      parsedName: null,
      rawText: '   ',
    });

    expect(commitItemDrafts([nameless], {})).toEqual([]);
  });
});

describe('commitReceiptInput', () => {
  it('carries the drafts and the updatedAt guard the editor last saw', () => {
    const receipt = detail({
      storeGroupId: STORE_ID,
      lines: [
        line({ id: 'new-line', reviewState: 'new', parsedName: 'SOURDOUGH' }),
      ],
    });

    expect(
      commitReceiptInput(receipt, {
        itemDrafts: { 'new-line': 'Sourdough loaf' },
        storeDraft: '',
      }),
    ).toEqual({
      expectedUpdatedAt: '2026-10-17T12:05:00.000Z',
      itemDrafts: [{ lineId: 'new-line', name: 'Sourdough loaf' }],
    });
  });

  it('sends a drafted store name, and never both spellings of the store', () => {
    const drafting = detail({ lines: [line({ reviewState: 'skipped' })] });
    expect(
      commitReceiptInput(drafting, {
        itemDrafts: {},
        storeDraft: ' Trader Joe’s ',
      }),
    ).toEqual({
      expectedUpdatedAt: '2026-10-17T12:05:00.000Z',
      storeDraft: 'Trader Joe’s',
    });

    const chosen = detail({
      storeGroupId: STORE_ID,
      lines: [line({ reviewState: 'skipped' })],
    });
    expect(
      commitReceiptInput(chosen, {
        itemDrafts: {},
        storeDraft: 'Trader Joe’s',
      }),
    ).toEqual({ expectedUpdatedAt: '2026-10-17T12:05:00.000Z' });
  });
});

describe('the refusal sentences', () => {
  it('reads the gate refusals in the reviewer’s words', () => {
    expect(
      commitErrorMessage(new ApiError(400, 'RECEIPT_NOT_REVIEWED', 'Review.')),
    ).toContain('decision');
    expect(
      commitErrorMessage(new ApiError(400, 'RECEIPT_STORE_REQUIRED', 'Store.')),
    ).toContain('store');
    expect(
      commitErrorMessage(
        new ApiError(409, 'RECEIPT_ALREADY_COMMITTED', 'Already.'),
      ),
    ).toContain('already committed');
    expect(
      commitErrorMessage(new ApiError(409, 'RECEIPT_CHANGED', 'Stale.')),
    ).toContain('another device');
  });

  it('falls back to the server’s own message, then to a generic one', () => {
    expect(
      commitErrorMessage(
        new ApiError(400, 'INVALID_ITEM', 'Pick a real item.'),
      ),
    ).toBe('Pick a real item.');
    expect(commitErrorMessage(new Error('boom'))).toContain('Try again');
    expect(
      commitErrorMessage(new ApiError(409, 'RECEIPT_COMMITTED', 'No.')),
    ).toBe('No.');
  });

  it('has one sentence for a committed discard', () => {
    expect(
      discardErrorMessage(
        new ApiError(
          409,
          'RECEIPT_COMMITTED',
          'A committed receipt cannot be discarded.',
        ),
      ),
    ).toBe('A committed receipt cannot be discarded.');
    expect(discardErrorMessage(new Error('boom'))).toContain('Try again');
  });
});
