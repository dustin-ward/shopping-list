import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import ItemManagement from '../../src/lib/components/items/ItemManagement.svelte';
import type {
  ItemReferenceCounts,
  ItemSummary,
  MergeItemsResult,
} from '../../src/lib/shared/schemas';

/**
 * The item-management surface as the household meets it: every item with the
 * footprint a merge would move, a rename form that says what it leaves alone,
 * a merge that asks twice, and the before/after table that proves the write.
 */

function readable(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/gu, '').replace(/ svelte-\w+/gu, '');
}

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
    id: `item-${name.toLowerCase().replaceAll(' ', '-')}`,
    name,
    counts: counts(),
    ...overrides,
  };
}

const noop = () => {};

function mergeResult(): MergeItemsResult {
  return {
    serverInstanceId: 'instance',
    revision: 7,
    survivor: { id: 'whole-milk', name: 'Whole milk' },
    absorbed: { id: 'milk', name: 'Milk' },
    before: {
      survivor: counts({ receiptLines: 1, liveAliases: 1 }),
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
        categoryMemberships: 1,
      }),
      absorbed: counts(),
    },
    aliasesMoved: 1,
    aliasesRetired: 0,
    aliasesLearned: 1,
    aliasesRevived: 0,
    membershipsDropped: 0,
  };
}

type Props = {
  writable?: boolean;
  busy?: boolean;
  renameDraft?: { itemId: string; name: string } | null;
  mergeDraft?: {
    absorbedId: string;
    survivorId: string | null;
    confirming: boolean;
  } | null;
  report?: MergeItemsResult | null;
  error?: string;
  notice?: string;
};

function renderItems(
  items: ItemSummary[],
  {
    writable = true,
    busy = false,
    renameDraft = null,
    mergeDraft = null,
    report = null,
    error = '',
    notice = '',
  }: Props = {},
): string {
  return readable(
    render(ItemManagement, {
      props: {
        items,
        writable,
        busy,
        renameDraft,
        mergeDraft,
        report,
        error,
        notice,
        onRenameStart: noop,
        onRenameName: noop,
        onRenameSubmit: noop,
        onRenameCancel: noop,
        onMergeStart: noop,
        onMergeSurvivor: noop,
        onMergeReview: noop,
        onMergeConfirm: noop,
        onMergeCancel: noop,
        onReportDismiss: noop,
      },
    }).body,
  );
}

const household = [
  item('Milk', {
    counts: counts({
      receiptLines: 2,
      purchases: 1,
      liveAliases: 1,
      listEntries: 1,
      activeListEntries: 1,
    }),
  }),
  item('Whole milk', { counts: counts({ receiptLines: 1 }) }),
];

describe('ItemManagement — the list', () => {
  it('shows every item with the footprint a merge would move', () => {
    const body = renderItems(household);

    expect(body).toContain('>Milk</h3>');
    expect(body).toContain(
      '2 receipt lines · 1 purchase · 1 alias · 1 list entry',
    );
    expect(body).toContain('1 receipt line');
    // Both writes are per item and named for the screen reader.
    expect(body).toContain('aria-label="Rename Milk"');
    expect(body).toContain('aria-label="Merge Milk into…"');
  });

  it('says the rename leaves printed evidence alone', () => {
    expect(renderItems(household)).toContain(
      'it never rewrites what a receipt printed or what an alias answers to',
    );
  });

  it('offers no actions without a writable connection', () => {
    const body = renderItems(household, { writable: false });

    expect(body).not.toContain('Rename');
    expect(body).not.toContain('Merge into');
    expect(body).toContain('Milk');
  });

  it('explains the empty state', () => {
    const body = renderItems([]);

    expect(body).toContain('No items yet.');
  });

  it('shows the container\u2019s error and notice', () => {
    const body = renderItems(household, {
      error: 'This item changed on another device.',
      notice: 'Renamed "Milk" to "Organic milk".',
    });

    expect(body).toContain('role="alert"');
    expect(body).toContain('This item changed on another device.');
    expect(body).toContain('role="status"');
    expect(body).toContain('Renamed "Milk" to "Organic milk".');
  });
});

describe('ItemManagement — renaming', () => {
  it('opens the term in a form that names the consequences', () => {
    const body = renderItems(household, {
      renameDraft: { itemId: 'item-milk', name: 'Milk' },
    });

    expect(body).toContain('New household term');
    expect(body).toContain('value="Milk"');
    expect(body).toContain('Save name');
    expect(body).toMatch(
      /Printed receipt text, purchase snapshots and aliases keep their\s+own wording\./u,
    );
    expect(body).toMatch(/Visible list entries adopt the new term\./u);
  });
});

describe('ItemManagement — merging', () => {
  it('asks which item absorbs the absorbed one, never offering itself', () => {
    const body = renderItems(household, {
      mergeDraft: {
        absorbedId: 'item-milk',
        survivorId: null,
        confirming: false,
      },
    });

    expect(body).toContain('Merge "Milk" into');
    expect(body).toContain('Choose an item…');
    expect(body).toContain('value="item-whole-milk"');
    expect(body).not.toContain('value="item-milk"');
    expect(body).toContain('Review merge');
    // Not until a survivor is chosen and reviewed.
    expect(body).not.toContain('Merge Milk into Whole milk');
  });

  it('asks for confirmation with the counts that will move', () => {
    const body = renderItems(household, {
      mergeDraft: {
        absorbedId: 'item-milk',
        survivorId: 'item-whole-milk',
        confirming: true,
      },
    });

    expect(body).toContain('Merge "Milk" into "Whole milk"?');
    expect(body).toContain(
      'Every reference to "Milk" moves to "Whole milk" (2 receipt lines · 1 purchase · 1 alias · 1 list entry)',
    );
    expect(body).toContain(
      'Printed receipt text, purchase snapshots and alias wording stay exactly as they are.',
    );
    expect(body).toContain('Merge Milk into Whole milk');
    expect(body).toContain('Cancel');
  });
});

describe('ItemManagement — the merge report', () => {
  it('proves nothing is left on the absorbed item and shows the after counts', () => {
    const body = renderItems(household, { report: mergeResult() });

    expect(body).toContain('Merged "Milk" into "Whole milk"');
    expect(body).toContain(
      'Nothing is left on "Milk": every reference now points at "Whole milk".',
    );
    expect(body).toContain('Reference counts: before and after');
    expect(body).toContain('"Milk" before');
    expect(body).toContain('"Milk" after');
    expect(body).toContain('"Whole milk" before');
    expect(body).toContain('"Whole milk" after');
    expect(body).toContain('Committed lines (price history)');
    expect(body).toContain(
      'Matching learns "Milk" for "Whole milk", so the absorbed phrase still resolves.',
    );
    expect(body).toContain('Dismiss report');

    // The receipt-line row reads 2 on the absorbed side before and 0 after, 1
    // on the survivor before, and the counted 3 after — the audit, not a promise.
    expect(body).toMatch(
      /Receipt lines[\s\S]*?<td[^>]*>2<\/td>[\s\S]*?<td[^>]*>0<\/td>[\s\S]*?<td[^>]*>1<\/td>[\s\S]*?<td[^>]*>3<\/td>/u,
    );
  });
});
