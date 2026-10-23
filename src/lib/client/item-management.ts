/**
 * The item-management surface's client half (ticket 19): what one item's
 * reference counts say, what a merge will move before it happens, and how the
 * server's before/after report reads afterward.
 *
 * The surface that renders this never calls `fetch` itself and never does the
 * arithmetic that proves a merge: the server counts before and after, and every
 * sentence here is a pure function over that answer.
 */

import { ApiError, requestJson } from './api';
import type {
  ItemOverview,
  ItemReferenceCounts,
  ItemSummary,
  MergeItemsResult,
  RenameItemResult,
} from '../shared/schemas';

/** The item whose name is being edited, as the surface holds it. */
export type RenameDraft = { itemId: string; name: string };

/** The merge being prepared: the absorbed item, its chosen survivor, and the confirm step. */
export type MergeDraft = {
  absorbedId: string;
  survivorId: string | null;
  confirming: boolean;
};

/** `1 line`, `2 lines` — a count as a phrase. */
function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * One item's footprint in the reviewer's words. Zero categories are left out so
 * a clean item reads short, and an item with no references says so rather than
 * rendering a row of zeros.
 */
export function itemCountSummary(counts: ItemReferenceCounts): string {
  const parts: string[] = [];
  if (counts.receiptLines > 0) {
    parts.push(
      countLabel(counts.receiptLines, 'receipt line', 'receipt lines'),
    );
  }
  if (counts.purchases > 0) {
    parts.push(countLabel(counts.purchases, 'purchase', 'purchases'));
  }
  const aliases = counts.liveAliases + counts.deletedAliases;
  if (aliases > 0) parts.push(countLabel(aliases, 'alias', 'aliases'));
  if (counts.listEntries > 0) {
    parts.push(countLabel(counts.listEntries, 'list entry', 'list entries'));
  }
  if (counts.categoryMemberships > 0) {
    parts.push(
      countLabel(counts.categoryMemberships, 'category', 'categories'),
    );
  }
  return parts.length > 0 ? parts.join(' · ') : 'No references yet';
}

/** What the reviewer is about to do, naming both terms. */
export function mergeQuestion(
  absorbed: ItemSummary,
  survivor: ItemSummary,
): string {
  return `Merge "${absorbed.name}" into "${survivor.name}"?`;
}

/**
 * What the merge will move, from the counts the list already shows. This is the
 * sentence the confirm tap stands on: every reference kind is named, and the
 * printed evidence is explicitly out of scope.
 */
export function mergeConsequences(
  absorbed: ItemSummary,
  survivor: ItemSummary,
): string {
  const moved = itemCountSummary(absorbed.counts);
  const references =
    moved === 'No references yet' ? 'nothing' : moved.toLowerCase();
  return `Every reference to "${absorbed.name}" moves to "${survivor.name}" (${references}), and "${absorbed.name}" is removed. Printed receipt text, purchase snapshots and alias wording stay exactly as they are.`;
}

/** One row of the audit table: each item before, and each item after. */
export type MergeAuditRow = {
  label: string;
  absorbedBefore: number;
  absorbedAfter: number;
  survivorBefore: number;
  survivorAfter: number;
  note: string;
};

/**
 * The audit table. Every "after" number is the server's own count, so the
 * absorbed-after column is the visible proof that nothing stayed behind, and
 * the alias/membership notes explain the only places a total can legitimately
 * stay level or shrink (a retired duplicate, a revived row, a dropped duplicate
 * membership).
 */
export function mergeAuditRows(result: MergeItemsResult): MergeAuditRow[] {
  const { before, after } = result;
  const aliasNotes: string[] = [];
  if (result.aliasesMoved > 0) {
    aliasNotes.push(
      countLabel(result.aliasesMoved, 'alias row moved', 'alias rows moved'),
    );
  }
  if (result.aliasesRetired > 0) {
    aliasNotes.push(
      countLabel(
        result.aliasesRetired,
        'retired as a duplicate',
        'retired as duplicates',
      ),
    );
  }
  if (result.aliasesLearned > 0) aliasNotes.push('absorbed term learned');
  if (result.aliasesRevived > 0) aliasNotes.push('deleted term revived');

  return [
    {
      label: 'Receipt lines',
      absorbedBefore: before.absorbed.receiptLines,
      absorbedAfter: after.absorbed.receiptLines,
      survivorBefore: before.survivor.receiptLines,
      survivorAfter: after.survivor.receiptLines,
      note: '',
    },
    {
      label: 'Committed lines (price history)',
      absorbedBefore: before.absorbed.committedReceiptLines,
      absorbedAfter: after.absorbed.committedReceiptLines,
      survivorBefore: before.survivor.committedReceiptLines,
      survivorAfter: after.survivor.committedReceiptLines,
      note: '',
    },
    {
      label: 'Purchases',
      absorbedBefore: before.absorbed.purchases,
      absorbedAfter: after.absorbed.purchases,
      survivorBefore: before.survivor.purchases,
      survivorAfter: after.survivor.purchases,
      note: 'Snapshots keep what was bought',
    },
    {
      label: 'Live aliases',
      absorbedBefore: before.absorbed.liveAliases,
      absorbedAfter: after.absorbed.liveAliases,
      survivorBefore: before.survivor.liveAliases,
      survivorAfter: after.survivor.liveAliases,
      note: aliasNotes.join(', '),
    },
    {
      label: 'Deleted aliases',
      absorbedBefore: before.absorbed.deletedAliases,
      absorbedAfter: after.absorbed.deletedAliases,
      survivorBefore: before.survivor.deletedAliases,
      survivorAfter: after.survivor.deletedAliases,
      note: 'Kept for audit',
    },
    {
      label: 'List entries',
      absorbedBefore: before.absorbed.listEntries,
      absorbedAfter: after.absorbed.listEntries,
      survivorBefore: before.survivor.listEntries,
      survivorAfter: after.survivor.listEntries,
      note: 'Visible entries adopt the surviving term',
    },
    {
      label: 'Active list entries',
      absorbedBefore: before.absorbed.activeListEntries,
      absorbedAfter: after.absorbed.activeListEntries,
      survivorBefore: before.survivor.activeListEntries,
      survivorAfter: after.survivor.activeListEntries,
      note: 'Still on the list',
    },
    {
      label: 'Categories',
      absorbedBefore: before.absorbed.categoryMemberships,
      absorbedAfter: after.absorbed.categoryMemberships,
      survivorBefore: before.survivor.categoryMemberships,
      survivorAfter: after.survivor.categoryMemberships,
      note:
        result.membershipsDropped > 0
          ? countLabel(
              result.membershipsDropped,
              'duplicate dropped',
              'duplicates dropped',
            )
          : '',
    },
  ];
}

/** What the report headline says: the absorbed term has nothing left. */
export function mergeReportSentence(result: MergeItemsResult): string {
  return `Nothing is left on "${result.absorbed.name}": every reference now points at "${result.survivor.name}".`;
}

/** What matching learns, so the absorbed phrase keeps resolving. */
export function mergeAliasSentence(result: MergeItemsResult): string {
  if (result.aliasesLearned > 0) {
    return `Matching learns "${result.absorbed.name}" for "${result.survivor.name}", so the absorbed phrase still resolves.`;
  }
  if (result.aliasesRevived > 0) {
    return `Matching revives "${result.absorbed.name}" for "${result.survivor.name}", so the absorbed phrase still resolves.`;
  }
  return `"${result.absorbed.name}" already resolves to "${result.survivor.name}".`;
}

/** The surface's read; fetched on demand, never part of the snapshot. */
export function fetchItemOverview(): Promise<ItemOverview> {
  return requestJson<ItemOverview>('/api/items');
}

/** Rename the household term, guarded by the name the caller last saw. */
export function submitItemRename(
  itemId: string,
  serverInstanceId: string,
  expectedName: string,
  name: string,
): Promise<RenameItemResult> {
  return requestJson<RenameItemResult>(`/api/items/${itemId}`, {
    method: 'PATCH',
    body: { serverInstanceId, expectedName, name },
  });
}

/** Merge the absorbed item into the survivor, guarded by both names. */
export function submitItemMerge(
  absorbed: ItemSummary,
  survivor: ItemSummary,
  serverInstanceId: string,
): Promise<MergeItemsResult> {
  return requestJson<MergeItemsResult>(`/api/items/${absorbed.id}/merge`, {
    method: 'POST',
    body: {
      serverInstanceId,
      survivorId: survivor.id,
      expectedName: absorbed.name,
      expectedSurvivorName: survivor.name,
    },
  });
}

/** One sentence for every refusal a rename can meet. */
export function renameErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'The item could not be renamed. Try again.';
  }
  switch (error.code) {
    case 'NOT_FOUND':
      return 'That item no longer exists — the list has been refreshed.';
    case 'ITEM_CHANGED':
      return 'This item changed on another device. The list has been refreshed — check the name and try again.';
    case 'ITEM_NAME_EXISTS':
      return 'Another item already uses that name. Merge the two instead, or choose another name.';
    default:
      return error.message;
  }
}

/** One sentence for every refusal a merge can meet. */
export function mergeErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'The items could not be merged. Try again.';
  }
  switch (error.code) {
    case 'NOT_FOUND':
      return 'One of these items no longer exists — the list has been refreshed.';
    case 'ITEM_CHANGED':
      return 'One of these items changed on another device. The list has been refreshed — review the merge and try again.';
    case 'MERGE_ACTIVE_ENTRY_CONFLICT':
      return error.message;
    case 'INVALID_MERGE':
      return 'Choose two different items to merge.';
    case 'MERGE_COUNT_MISMATCH':
      return 'The merge could not prove that every reference moved, so nothing was changed. Try again or refresh.';
    default:
      return error.message;
  }
}
