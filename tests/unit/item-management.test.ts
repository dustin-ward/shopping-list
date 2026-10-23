import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/lib/client/api';
import {
  itemCountSummary,
  mergeAliasSentence,
  mergeAuditRows,
  mergeConsequences,
  mergeErrorMessage,
  mergeQuestion,
  mergeReportSentence,
  renameErrorMessage,
} from '../../src/lib/client/item-management';
import type {
  ItemReferenceCounts,
  ItemSummary,
  MergeItemsResult,
} from '../../src/lib/shared/schemas';

/**
 * The item-management surface's sentences and audit arithmetic: what an item's
 * footprint says, what a merge promises to move, and how the server's
 * before/after report reads. The server computes the counts; these tests pin the
 * words and the rendering rules around them.
 */

function counts(
  overrides: Partial<ItemReferenceCounts> = {},
): ItemReferenceCounts {
  return {
    receiptLines: 0,
    committedReceiptLines: 0,
    purchases: 0,
    liveAliases: 0,
    deletedAliases: 0,
    listEntries: 0,
    activeListEntries: 0,
    categoryMemberships: 0,
    ...overrides,
  };
}

function item(name: string, overrides: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id: `item-${name}`,
    name,
    counts: counts(),
    ...overrides,
  };
}

function mergeResult(
  overrides: Partial<MergeItemsResult> = {},
): MergeItemsResult {
  return {
    serverInstanceId: 'instance',
    revision: 7,
    survivor: { id: 'whole-milk', name: 'Whole milk' },
    absorbed: { id: 'milk', name: 'Milk' },
    before: {
      survivor: counts({ receiptLines: 1, categoryMemberships: 1 }),
      absorbed: counts({
        receiptLines: 2,
        committedReceiptLines: 1,
        purchases: 1,
        liveAliases: 1,
        listEntries: 1,
        activeListEntries: 1,
        categoryMemberships: 1,
      }),
    },
    after: {
      survivor: counts({
        receiptLines: 3,
        committedReceiptLines: 1,
        purchases: 1,
        liveAliases: 2,
        listEntries: 1,
        activeListEntries: 1,
        categoryMemberships: 2,
      }),
      absorbed: counts(),
    },
    aliasesMoved: 1,
    aliasesRetired: 0,
    aliasesLearned: 1,
    aliasesRevived: 0,
    membershipsDropped: 0,
    ...overrides,
  };
}

describe('itemCountSummary', () => {
  it('names every non-zero reference with the right plural', () => {
    expect(
      itemCountSummary(
        counts({
          receiptLines: 2,
          purchases: 1,
          liveAliases: 1,
          deletedAliases: 1,
          listEntries: 2,
          activeListEntries: 1,
          categoryMemberships: 1,
        }),
      ),
    ).toBe(
      '2 receipt lines · 1 purchase · 2 aliases · 2 list entries · 1 category',
    );
  });

  it('leaves zero categories out', () => {
    expect(itemCountSummary(counts({ receiptLines: 1 }))).toBe(
      '1 receipt line',
    );
  });

  it('says so when nothing references the item', () => {
    expect(itemCountSummary(counts())).toBe('No references yet');
  });
});

describe('the merge question', () => {
  it('names both terms', () => {
    const absorbed = item('Milk', { counts: counts({ receiptLines: 2 }) });
    const survivor = item('Whole milk');

    expect(mergeQuestion(absorbed, survivor)).toBe(
      'Merge "Milk" into "Whole milk"?',
    );
    expect(mergeConsequences(absorbed, survivor)).toContain(
      'Every reference to "Milk" moves to "Whole milk" (2 receipt lines)',
    );
    expect(mergeConsequences(absorbed, survivor)).toContain(
      'Printed receipt text, purchase snapshots and alias wording stay exactly as they are.',
    );
  });

  it('says "nothing" for an item with no references', () => {
    expect(mergeConsequences(item('Milk'), item('Whole milk'))).toContain(
      '(nothing)',
    );
  });
});

describe('the merge audit table', () => {
  it('shows the absorbed before and after, the survivor before, and the counted after', () => {
    const rows = mergeAuditRows(mergeResult());

    expect(rows.find((row) => row.label === 'Receipt lines')).toEqual({
      label: 'Receipt lines',
      absorbedBefore: 2,
      absorbedAfter: 0,
      survivorBefore: 1,
      survivorAfter: 3,
      note: '',
    });
    expect(rows.find((row) => row.label === 'Purchases')).toMatchObject({
      absorbedBefore: 1,
      absorbedAfter: 0,
      survivorBefore: 0,
      survivorAfter: 1,
      note: 'Snapshots keep what was bought',
    });
    expect(rows.find((row) => row.label === 'Categories')).toMatchObject({
      absorbedBefore: 1,
      absorbedAfter: 0,
      survivorBefore: 1,
      survivorAfter: 2,
    });
  });

  it('explains alias bookkeeping in the live row and keeps deleted rows visible', () => {
    const result = mergeResult({
      aliasesMoved: 2,
      aliasesRetired: 1,
      aliasesLearned: 1,
      aliasesRevived: 0,
    });
    const rows = mergeAuditRows(result);

    expect(rows.find((row) => row.label === 'Live aliases')?.note).toBe(
      '2 alias rows moved, 1 retired as a duplicate, absorbed term learned',
    );
    expect(rows.find((row) => row.label === 'Deleted aliases')?.note).toBe(
      'Kept for audit',
    );
  });

  it('names a dropped duplicate category membership', () => {
    const rows = mergeAuditRows(mergeResult({ membershipsDropped: 1 }));

    expect(rows.find((row) => row.label === 'Categories')?.note).toBe(
      '1 duplicate dropped',
    );
  });
});

describe('the merge report sentences', () => {
  it('says nothing is left on the absorbed item', () => {
    expect(mergeReportSentence(mergeResult())).toBe(
      'Nothing is left on "Milk": every reference now points at "Whole milk".',
    );
  });

  it('says what matching learned, revived, or already knew', () => {
    expect(mergeAliasSentence(mergeResult({ aliasesLearned: 1 }))).toBe(
      'Matching learns "Milk" for "Whole milk", so the absorbed phrase still resolves.',
    );
    expect(
      mergeAliasSentence(mergeResult({ aliasesLearned: 0, aliasesRevived: 1 })),
    ).toBe(
      'Matching revives "Milk" for "Whole milk", so the absorbed phrase still resolves.',
    );
    expect(
      mergeAliasSentence(mergeResult({ aliasesLearned: 0, aliasesRevived: 0 })),
    ).toBe('"Milk" already resolves to "Whole milk".');
  });
});

describe('refusal messages', () => {
  it('turns a rename collision into the merge advice', () => {
    expect(
      renameErrorMessage(
        new ApiError(409, 'ITEM_NAME_EXISTS', 'A group with this name exists.'),
      ),
    ).toBe(
      'Another item already uses that name. Merge the two instead, or choose another name.',
    );
  });

  it('keeps the server sentence for an active-entry conflict', () => {
    const message =
      'Both "Milk" and "Whole milk" are on the list. Remove one from the list, then merge.';
    expect(
      mergeErrorMessage(
        new ApiError(409, 'MERGE_ACTIVE_ENTRY_CONFLICT', message),
      ),
    ).toBe(message);
  });

  it('explains that a failed audit wrote nothing', () => {
    expect(
      mergeErrorMessage(
        new ApiError(500, 'MERGE_COUNT_MISMATCH', 'unexpected'),
      ),
    ).toBe(
      'The merge could not prove that every reference moved, so nothing was changed. Try again or refresh.',
    );
  });

  it('falls back to a generic sentence for an unknown failure', () => {
    expect(renameErrorMessage(new Error('offline'))).toBe(
      'The item could not be renamed. Try again.',
    );
    expect(mergeErrorMessage(new Error('offline'))).toBe(
      'The items could not be merged. Try again.',
    );
  });
});
