import { describe, expect, it } from 'vitest';
import {
  planReceiptCommit,
  type CommittableLine,
  type CommitPlanInput,
} from '../../src/lib/server/receipts/commit-plan';

/**
 * The commit plan's rules, as pure data (plan §5 "Commit"). The service only
 * executes what this returns, so the gate, the materialization and the alias
 * learning are all decided — and read — here.
 */

const MILK_ID = '00000000-0000-4000-8000-0000000000aa';
const STORE_ID = '00000000-0000-4000-8000-0000000000bb';

function line(overrides: Partial<CommittableLine> = {}): CommittableLine {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    rawText: 'MILK 2% 1L',
    parsedName: null,
    isItemChunk: true,
    reviewState: 'bound',
    catalogItemId: MILK_ID,
    ...overrides,
  };
}

function plan(overrides: Partial<CommitPlanInput> = {}) {
  return planReceiptCommit({
    lines: [line()],
    itemDrafts: [],
    storeGroupId: STORE_ID,
    storeDraft: null,
    items: [{ id: MILK_ID, normalizedName: 'milk' }],
    groups: [{ id: STORE_ID, normalizedName: 'corner market', kind: 'store' }],
    ...overrides,
  });
}

/** The refusal a callback throws, as the API error it will be answered with. */
function refusal(run: () => unknown): Record<string, unknown> {
  try {
    run();
  } catch (error) {
    return error as Record<string, unknown>;
  }
  throw new Error('expected the commit to be refused');
}

describe('planReceiptCommit — the gate', () => {
  it('refuses a receipt with an unreviewed item line, naming it', () => {
    const unreviewed = line({
      id: '00000000-0000-4000-8000-000000000002',
      reviewState: 'unreviewed',
      catalogItemId: null,
    });

    expect(refusal(() => plan({ lines: [line(), unreviewed] }))).toMatchObject({
      status: 400,
      code: 'RECEIPT_NOT_REVIEWED',
      details: { lineIds: [unreviewed.id] },
    });
  });

  it('lets a parked row stay unreviewed — it never gates a commit', () => {
    const result = plan({
      lines: [
        line(),
        line({
          id: '00000000-0000-4000-8000-000000000003',
          rawText: 'SUBTOTAL',
          isItemChunk: false,
          reviewState: 'unreviewed',
          catalogItemId: null,
        }),
      ],
    });

    expect(result.lineWrites).toEqual([]);
  });

  it('accepts a line in any decided state', () => {
    for (const reviewState of ['bound', 'new', 'unknown', 'skipped'] as const) {
      const id = line().id;
      expect(() =>
        plan({
          lines: [
            line({
              reviewState,
              catalogItemId: reviewState === 'bound' ? MILK_ID : null,
            }),
          ],
          itemDrafts:
            reviewState === 'new' ? [{ lineId: id, name: 'Milk' }] : [],
        }),
      ).not.toThrow();
    }
  });

  it('refuses a commit with no store', () => {
    expect(refusal(() => plan({ storeGroupId: null }))).toMatchObject({
      status: 400,
      code: 'RECEIPT_STORE_REQUIRED',
    });
  });

  it('refuses a group that is not a live store', () => {
    const groups = [
      { id: STORE_ID, normalizedName: 'dairy', kind: 'category' as const },
    ];
    expect(refusal(() => plan({ groups }))).toMatchObject({
      status: 400,
      code: 'INVALID_STORE',
    });
  });

  it('refuses a store that was chosen and drafted at once', () => {
    expect(refusal(() => plan({ storeDraft: 'Trader Joe’s' }))).toMatchObject({
      status: 400,
      code: 'INVALID_STORE',
    });
  });
});

describe('planReceiptCommit — materialization', () => {
  const itemDraftLine = line({
    id: '00000000-0000-4000-8000-00000000000a',
    rawText: 'SOURDOUGH BREAD',
    reviewState: 'new',
    catalogItemId: null,
  });

  it('creates the item a `new` line drafted and binds the line to it', () => {
    const result = plan({
      lines: [itemDraftLine],
      itemDrafts: [{ lineId: itemDraftLine.id, name: 'Sourdough loaf' }],
    });

    expect(result.newItems).toEqual([
      { name: 'Sourdough loaf', normalizedName: 'sourdough loaf' },
    ]);
    expect(result.lineWrites).toEqual([
      {
        lineId: itemDraftLine.id,
        item: { kind: 'new', normalizedName: 'sourdough loaf' },
        boundVia: 'created',
      },
    ]);
    expect(result.createsEntities).toBe(true);
  });

  it('creates one item for two drafts of the same name, and binds both lines', () => {
    const second = line({
      id: '00000000-0000-4000-8000-00000000000b',
      rawText: 'SOURDOUGH BREAD',
      reviewState: 'new',
      catalogItemId: null,
    });

    const result = plan({
      lines: [itemDraftLine, second],
      itemDrafts: [
        { lineId: itemDraftLine.id, name: 'Sourdough loaf' },
        { lineId: second.id, name: '  sourdough   LOAF ' },
      ],
    });

    expect(result.newItems).toHaveLength(1);
    expect(result.lineWrites.map((write) => write.item)).toEqual([
      { kind: 'new', normalizedName: 'sourdough loaf' },
      { kind: 'new', normalizedName: 'sourdough loaf' },
    ]);
  });

  it('binds an existing item when a draft collides with it, and creates nothing', () => {
    const result = plan({
      lines: [itemDraftLine],
      itemDrafts: [{ lineId: itemDraftLine.id, name: 'Milk' }],
    });

    expect(result.newItems).toEqual([]);
    expect(result.lineWrites).toEqual([
      {
        lineId: itemDraftLine.id,
        item: { kind: 'existing', id: MILK_ID },
        boundVia: 'manual',
      },
    ]);
    expect(result.createsEntities).toBe(false);
  });

  it('refuses a draft naming a line that is not drafting an item', () => {
    expect(
      refusal(() =>
        plan({ itemDrafts: [{ lineId: line().id, name: 'Milk' }] }),
      ),
    ).toMatchObject({ status: 400, code: 'INVALID_LINE' });
  });

  it('refuses a `new` line whose draft name never arrived', () => {
    expect(refusal(() => plan({ lines: [itemDraftLine] }))).toMatchObject({
      status: 400,
      code: 'INVALID_LINE',
    });
  });

  it('writes no line changes for lines that already carry their binding', () => {
    const result = plan({
      lines: [
        line(),
        line({
          id: '00000000-0000-4000-8000-00000000000c',
          reviewState: 'unknown',
          catalogItemId: null,
        }),
        line({
          id: '00000000-0000-4000-8000-00000000000d',
          reviewState: 'skipped',
          catalogItemId: null,
        }),
      ],
    });

    expect(result.newItems).toEqual([]);
    expect(result.lineWrites).toEqual([]);
  });

  it('materializes a drafted store as a new group', () => {
    const result = plan({
      storeGroupId: null,
      storeDraft: 'Trader Joe’s',
    });

    expect(result.store).toEqual({
      kind: 'new',
      name: 'Trader Joe’s',
      normalizedName: 'trader joe’s',
    });
    expect(result.createsEntities).toBe(true);
  });

  it('reuses a live store group when the drafted name is its name', () => {
    const result = plan({ storeGroupId: null, storeDraft: 'corner MARKET' });

    expect(result.store).toEqual({ kind: 'existing', groupId: STORE_ID });
    expect(result.createsEntities).toBe(false);
  });

  it('refuses a drafted store whose name a live category already holds', () => {
    const groups = [
      { id: STORE_ID, normalizedName: 'corner market', kind: 'store' as const },
      {
        id: '00000000-0000-4000-8000-0000000000cc',
        normalizedName: 'dairy',
        kind: 'category' as const,
      },
    ];

    expect(
      refusal(() => plan({ storeGroupId: null, storeDraft: 'Dairy', groups })),
    ).toMatchObject({ status: 409, code: 'GROUP_NAME_EXISTS' });
  });
});

describe('planReceiptCommit — alias learning', () => {
  it('learns the reviewed printed text of a bound line', () => {
    const result = plan();

    expect(result.aliases).toEqual([
      {
        lineId: line().id,
        item: { kind: 'existing', id: MILK_ID },
        aliasText: 'MILK 2% 1L',
        normalizedAlias: 'milk 2% 1l',
      },
    ]);
  });

  it('learns the text of a line that created its item, trimmed', () => {
    const bread = line({
      id: '00000000-0000-4000-8000-00000000000a',
      rawText: '  SOURDOUGH BREAD ',
      reviewState: 'new',
      catalogItemId: null,
    });

    const result = plan({
      lines: [bread],
      itemDrafts: [{ lineId: bread.id, name: 'Sourdough loaf' }],
    });

    expect(result.aliases).toEqual([
      {
        lineId: bread.id,
        item: { kind: 'new', normalizedName: 'sourdough loaf' },
        aliasText: 'SOURDOUGH BREAD',
        normalizedAlias: 'sourdough bread',
      },
    ]);
  });

  it('learns the phrase the matcher reads, not the printed quantity', () => {
    const cucumbers = line({
      rawText: 'CUCUMBERS 2 @ 1.50',
      parsedName: 'CUCUMBERS',
    });

    const result = plan({ lines: [cucumbers] });

    expect(result.aliases).toEqual([
      {
        lineId: cucumbers.id,
        item: { kind: 'existing', id: MILK_ID },
        aliasText: 'CUCUMBERS',
        normalizedAlias: 'cucumbers',
      },
    ]);
  });

  it('learns one phrase once, however many lines print it', () => {
    const second = line({
      id: '00000000-0000-4000-8000-00000000000b',
      rawText: 'milk 2% 1l',
    });

    const result = plan({ lines: [line(), second] });

    expect(result.aliases).toHaveLength(1);
    expect(result.aliases[0]!.lineId).toBe(line().id);
  });

  it('keeps one phrase pointing at two items — a conflict, not a merge', () => {
    const cheeseId = '00000000-0000-4000-8000-0000000000dd';
    const cheese = line({
      id: '00000000-0000-4000-8000-00000000000c',
      catalogItemId: cheeseId,
    });

    const result = plan({
      lines: [line(), cheese],
      items: [
        { id: MILK_ID, normalizedName: 'milk' },
        { id: cheeseId, normalizedName: 'cheese' },
      ],
    });

    expect(result.aliases.map((alias) => alias.item)).toEqual([
      { kind: 'existing', id: MILK_ID },
      { kind: 'existing', id: cheeseId },
    ]);
  });

  it('learns nothing from an unknown or skipped line', () => {
    for (const reviewState of ['unknown', 'skipped'] as const) {
      const result = plan({
        lines: [
          line({ reviewState, catalogItemId: null }),
          line({ id: '00000000-0000-4000-8000-00000000000e' }),
        ],
      });

      expect(result.aliases).toHaveLength(1);
      expect(result.aliases[0]!.item).toEqual({
        kind: 'existing',
        id: MILK_ID,
      });
    }
  });

  it('bumps nothing when the commit only bound rows the list already had', () => {
    const result = plan();

    expect(result.createsEntities).toBe(false);
    expect(result.aliases).not.toHaveLength(0);
  });
});
