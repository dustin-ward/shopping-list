/**
 * What one canonical-item merge decides, as pure data (ticket 19; plan §5
 * "Merge semantics (later)": merge the household and price-history identity of
 * one item into another).
 *
 * A merge is the only write that removes a canonical item, so two decisions are
 * worth reading without a database:
 *
 * - **Where every alias goes.** Absorbed aliases move to the survivor. A live
 *   absorbed alias whose phrase the survivor already claims is *retired* — soft
 *   deleted, never dropped, because the audit trail is what soft deletion is for
 *   (`ADR 0003`). The absorbed household term itself becomes a phrase of the
 *   survivor, so the phrase that used to name the absorbed item still resolves
 *   after the item row is gone; a soft-deleted survivor alias for that phrase is
 *   revived rather than duplicated.
 * - **Whether nothing was lost.** The service counts every reference before and
 *   after the transaction and hands both counts here; a merge whose arithmetic
 *   does not reconcile is a bug, and the service rolls it back rather than
 *   leaving half the history on a removed row.
 */

import { normalizeName } from '../../shared/normalize';
import type { ItemReferenceCounts } from '../../shared/schemas';

/** One stored alias, as the merge reads it. */
export type AliasRow = {
  id: string;
  aliasText: string;
  normalizedAlias: string;
  deletedAt: string | null;
};

/** What the survivor should learn for the absorbed household term. */
export type AliasLearning =
  | { kind: 'none' }
  | { kind: 'create'; aliasText: string; normalizedAlias: string }
  | { kind: 'revive'; id: string };

export type AliasTransfer = {
  /** Absorbed rows to re-point at the survivor, in the order they were read. */
  moveIds: string[];
  /** Absorbed rows that must be soft-deleted first: the survivor already claims the phrase. */
  retireIds: string[];
  learned: AliasLearning;
};

/**
 * Decide the absorbed aliases' journey. `absorbedName` is the absorbed item's
 * household term — deleted and live aliases both count as moved rows, since a
 * deleted alias is still evidence of a phrase once confirmed.
 */
export function planAliasTransfer(
  survivorAliases: readonly AliasRow[],
  absorbedAliases: readonly AliasRow[],
  absorbedName: string,
): AliasTransfer {
  const livePhrases = new Set(
    survivorAliases
      .filter((alias) => alias.deletedAt === null)
      .map((alias) => alias.normalizedAlias),
  );

  const moveIds: string[] = [];
  const retireIds: string[] = [];
  for (const alias of absorbedAliases) {
    moveIds.push(alias.id);
    if (alias.deletedAt !== null) continue;
    if (livePhrases.has(alias.normalizedAlias)) {
      // The survivor already answers to this phrase: the surviving live row is
      // enough, and the absorbed one becomes audit evidence rather than a
      // second live claim (the partial unique index would refuse it anyway).
      retireIds.push(alias.id);
    } else {
      livePhrases.add(alias.normalizedAlias);
    }
  }

  const normalizedName = normalizeName(absorbedName);
  if (!normalizedName || livePhrases.has(normalizedName)) {
    return { moveIds, retireIds, learned: { kind: 'none' } };
  }

  // Another item may already claim this phrase: aliases are unique per item,
  // not per list. The absorbed household name was already a tier-1 claim before
  // the merge, so learning it keeps the claim count unchanged; if a third item
  // also claims the phrase, it was ambiguous before and stays ambiguous after.

  // Revive the lowest-id deleted row for the phrase so the outcome is stable
  // and the partial unique index is never doubled (the commit path's rule).
  const revive = [...survivorAliases, ...absorbedAliases]
    .filter(
      (alias) =>
        alias.deletedAt !== null && alias.normalizedAlias === normalizedName,
    )
    .sort((left, right) => left.id.localeCompare(right.id))[0];
  if (revive)
    return { moveIds, retireIds, learned: { kind: 'revive', id: revive.id } };

  return {
    moveIds,
    retireIds,
    learned: {
      kind: 'create',
      aliasText: absorbedName.trim(),
      normalizedAlias: normalizedName,
    },
  };
}

/** The reference counts a merge has to reconcile, plus its alias bookkeeping. */
export type MergeCountAudit = {
  before: { survivor: ItemReferenceCounts; absorbed: ItemReferenceCounts };
  after: { survivor: ItemReferenceCounts; absorbed: ItemReferenceCounts };
  aliasesRetired: number;
  aliasesLearned: number;
  aliasesRevived: number;
  membershipsDropped: number;
};

/** Counts that move one-for-one; the survivor must end with the sum. */
const ADDITIVE_FIELDS = [
  'receiptLines',
  'committedReceiptLines',
  'purchases',
  'listEntries',
] as const;

/**
 * Every way the merge's after-counts can disagree with its before-counts. An
 * empty list is the proof that the transaction moved every reference and left
 * none on the absorbed item; the service throws on a non-empty list so SQLite
 * rolls the transaction back.
 */
export function mergeCountProblems(audit: MergeCountAudit): string[] {
  const problems: string[] = [];
  const { before, after } = audit;

  for (const field of ADDITIVE_FIELDS) {
    checkZero(problems, `absorbed ${field}`, after.absorbed[field]);
    expect(
      problems,
      `survivor ${field}`,
      before.survivor[field] + before.absorbed[field],
      after.survivor[field],
    );
  }

  checkZero(
    problems,
    'absorbed activeListEntries',
    after.absorbed.activeListEntries,
  );
  expect(
    problems,
    'survivor activeListEntries',
    before.survivor.activeListEntries + before.absorbed.activeListEntries,
    after.survivor.activeListEntries,
  );
  if (after.survivor.activeListEntries > 1) {
    problems.push(
      `survivor activeListEntries: expected at most 1, found ${after.survivor.activeListEntries}`,
    );
  }

  checkZero(
    problems,
    'absorbed categoryMemberships',
    after.absorbed.categoryMemberships,
  );
  expect(
    problems,
    'survivor categoryMemberships',
    before.survivor.categoryMemberships +
      before.absorbed.categoryMemberships -
      audit.membershipsDropped,
    after.survivor.categoryMemberships,
  );

  checkZero(problems, 'absorbed liveAliases', after.absorbed.liveAliases);
  expect(
    problems,
    'survivor liveAliases',
    before.survivor.liveAliases +
      before.absorbed.liveAliases -
      audit.aliasesRetired +
      audit.aliasesLearned +
      audit.aliasesRevived,
    after.survivor.liveAliases,
  );

  checkZero(problems, 'absorbed deletedAliases', after.absorbed.deletedAliases);
  expect(
    problems,
    'survivor deletedAliases',
    before.survivor.deletedAliases +
      before.absorbed.deletedAliases +
      audit.aliasesRetired -
      audit.aliasesRevived,
    after.survivor.deletedAliases,
  );

  // The total-row check: a retired row moved from live to deleted, a revived
  // one moved back, and only a freshly learned alias adds a row at all.
  expect(
    problems,
    'survivor alias rows',
    before.survivor.liveAliases +
      before.survivor.deletedAliases +
      before.absorbed.liveAliases +
      before.absorbed.deletedAliases +
      audit.aliasesLearned,
    after.survivor.liveAliases + after.survivor.deletedAliases,
  );

  return problems;
}

function checkZero(problems: string[], label: string, value: number): void {
  if (value !== 0) problems.push(`${label}: expected 0, found ${value}`);
}

function expect(
  problems: string[],
  label: string,
  expected: number,
  actual: number,
): void {
  if (expected !== actual) {
    problems.push(`${label}: expected ${expected}, found ${actual}`);
  }
}
