import { describe, expect, it } from 'vitest';
import {
  mergeCountProblems,
  planAliasTransfer,
  type AliasRow,
  type MergeCountAudit,
} from '../../src/lib/server/items/merge-plan';
import type { ItemReferenceCounts } from '../../src/lib/shared/schemas';

/**
 * The two decisions a merge makes before it writes: where every absorbed alias
 * goes (including the phrase the absorbed household term itself names), and
 * whether the before/after counts prove that nothing was left behind.
 */

function alias(
  normalizedAlias: string,
  overrides: Partial<AliasRow> = {},
): AliasRow {
  return {
    id: `alias-${normalizedAlias}-${overrides.deletedAt ? 'deleted' : 'live'}`,
    aliasText: normalizedAlias.toUpperCase(),
    normalizedAlias,
    deletedAt: null,
    ...overrides,
  };
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

describe('planAliasTransfer', () => {
  it('moves every absorbed alias row to the survivor when nothing competes', () => {
    const plan = planAliasTransfer(
      [],
      [
        alias('dairyland 2% 1l'),
        alias('milk 1gal', { deletedAt: '2026-10-01' }),
      ],
      'Milk',
    );

    expect(plan).toEqual({
      moveIds: ['alias-dairyland 2% 1l-live', 'alias-milk 1gal-deleted'],
      retireIds: [],
      // The absorbed term "Milk" is nobody's live phrase after the move: the
      // row printing "MILK 1GAL" is soft deleted, so the survivor learns the
      // term itself and the phrase keeps resolving.
      learned: {
        kind: 'create',
        aliasText: 'Milk',
        normalizedAlias: 'milk',
      },
    });
  });

  it('retires a live duplicate the survivor already claims instead of doubling it', () => {
    const plan = planAliasTransfer(
      [alias('dairyland 2% 1l')],
      [alias('dairyland 2% 1l')],
      'Whole milk',
    );

    expect(plan.moveIds).toEqual(['alias-dairyland 2% 1l-live']);
    expect(plan.retireIds).toEqual(['alias-dairyland 2% 1l-live']);
    // The absorbed term names a phrase nobody has yet.
    expect(plan.learned).toEqual({
      kind: 'create',
      aliasText: 'Whole milk',
      normalizedAlias: 'whole milk',
    });
  });

  it('learns the absorbed household term when the survivor has no phrase for it', () => {
    const plan = planAliasTransfer([], [], '  Milk  ');

    expect(plan).toMatchObject({
      moveIds: [],
      retireIds: [],
      learned: {
        kind: 'create',
        aliasText: 'Milk',
        normalizedAlias: 'milk',
      },
    });
  });

  it('revives a soft-deleted survivor alias rather than inserting a second row', () => {
    const deleted = alias('milk', { deletedAt: '2026-10-01' });
    const plan = planAliasTransfer([deleted], [], 'MILK');

    expect(plan.learned).toEqual({ kind: 'revive', id: 'alias-milk-deleted' });
  });

  it('learns nothing when the survivor already answers to the absorbed term', () => {
    const plan = planAliasTransfer([alias('milk')], [], 'Milk');

    expect(plan).toMatchObject({ learned: { kind: 'none' } });
  });

  it('learns nothing from a term that normalizes to nothing', () => {
    const plan = planAliasTransfer([], [], '   ');

    expect(plan).toMatchObject({ learned: { kind: 'none' } });
  });
});

/** A merge where one absorbed row of each kind moves to the survivor. */
function reconciledAudit(
  overrides: Partial<MergeCountAudit> = {},
): MergeCountAudit {
  return {
    before: {
      survivor: counts({
        receiptLines: 1,
        liveAliases: 1,
        listEntries: 1,
        activeListEntries: 1,
        categoryMemberships: 1,
      }),
      absorbed: counts({
        receiptLines: 2,
        committedReceiptLines: 1,
        purchases: 1,
        liveAliases: 1,
        deletedAliases: 1,
        listEntries: 2,
        categoryMemberships: 2,
      }),
    },
    after: {
      survivor: counts({
        receiptLines: 3,
        committedReceiptLines: 1,
        purchases: 1,
        liveAliases: 2,
        deletedAliases: 1,
        listEntries: 3,
        activeListEntries: 1,
        categoryMemberships: 3,
      }),
      absorbed: counts(),
    },
    aliasesRetired: 0,
    aliasesLearned: 0,
    aliasesRevived: 0,
    membershipsDropped: 0,
    ...overrides,
  };
}

describe('mergeCountProblems', () => {
  it('accepts an audit that reconciles every reference', () => {
    expect(mergeCountProblems(reconciledAudit())).toEqual([]);
  });

  it('accounts for a retired duplicate alias: live one down, deleted one up', () => {
    const audit = reconciledAudit({
      aliasesRetired: 1,
      aliasesLearned: 1,
    });

    // Retiring moves one live row of the absorbed item to deleted; learning
    // adds a live row for the absorbed household term.
    audit.after.survivor.liveAliases = 2;
    audit.after.survivor.deletedAliases = 2;
    expect(mergeCountProblems(audit)).toEqual([]);
  });

  it('accounts for a revived alias: one live row up, one deleted row down', () => {
    const audit = reconciledAudit({ aliasesRevived: 1 });
    audit.before.survivor.deletedAliases = 1;
    // before: live 1 + 1 = 2, deleted 1 + 1 = 2
    // after the revival: live 2 + 1 = 3, deleted 2 - 1 = 1
    audit.after.survivor.liveAliases = 3;
    audit.after.survivor.deletedAliases = 1;

    expect(mergeCountProblems(audit)).toEqual([]);
  });

  it('accounts for a dropped duplicate category membership', () => {
    const audit = reconciledAudit({ membershipsDropped: 1 });
    audit.after.survivor.categoryMemberships = 2;

    expect(mergeCountProblems(audit)).toEqual([]);
  });

  it('reports a reference still pointing at the absorbed item', () => {
    const audit = reconciledAudit();
    audit.after.absorbed.purchases = 1;

    expect(mergeCountProblems(audit)).toContain(
      'absorbed purchases: expected 0, found 1',
    );
  });

  it('reports a row the survivor did not receive', () => {
    const audit = reconciledAudit();
    audit.after.survivor.receiptLines = 2;

    expect(mergeCountProblems(audit)).toContain(
      'survivor receiptLines: expected 3, found 2',
    );
  });

  it('reports aliases that neither moved nor stayed', () => {
    const audit = reconciledAudit();
    audit.after.survivor.deletedAliases = 0;

    expect(mergeCountProblems(audit)).toContain(
      'survivor deletedAliases: expected 1, found 0',
    );
  });

  it('reports a merge that would leave two active list entries', () => {
    const audit = reconciledAudit();
    audit.before.survivor.activeListEntries = 1;
    audit.before.absorbed.activeListEntries = 1;
    audit.after.survivor.activeListEntries = 2;

    expect(mergeCountProblems(audit)).toContain(
      'survivor activeListEntries: expected at most 1, found 2',
    );
  });
});
