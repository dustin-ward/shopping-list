/**
 * What one commit writes, as pure data (plan §5 "Commit").
 *
 * The service executes this plan inside one transaction; every decision lives
 * here so it can be read and tested without a database: the gate (no
 * `unreviewed` item line, a confirmed store), the materialization of drafted
 * items and stores, the bindings the materialized lines get, and the aliases the
 * reviewed text teaches.
 *
 * Two rules the schema cannot express are deliberately decided here:
 *
 * - **A collision binds.** A drafted item whose normalized name is already in
 *   the catalog is not created again (and, per plan §7, the existing item is not
 *   renamed) — the line binds it, as `manual`, because nothing was created.
 * - **An item line that created its item keeps `review_state='new'`** and records
 *   `bound_via='created'`: the state is what the reviewer did, the provenance is
 *   what the binding came from.
 */

import { AppError, badRequest, conflict } from '../errors';
import { normalizeName } from '../../shared/normalize';
import type { ReceiptReviewState } from '../../shared/schemas';

/** One line as commit reads it: parked rows included, so the no-loss rule holds. */
export type CommittableLine = {
  id: string;
  rawText: string;
  isItemChunk: boolean;
  reviewState: ReceiptReviewState;
  catalogItemId: string | null;
};

/** A name the reviewer gave an inline-created item, keyed to the line that drafted it. */
export type ItemDraft = { lineId: string; name: string };

/** A catalog item the list already has. */
export type ExistingItem = { id: string; normalizedName: string };

/** A live group, so the store can be resolved without a query of its own. */
export type LiveGroup = {
  id: string;
  normalizedName: string;
  kind: 'store' | 'category';
};

export type CommitPlanInput = {
  lines: readonly CommittableLine[];
  itemDrafts: readonly ItemDraft[];
  /** The store the reviewer chose; null while a draft stands in. */
  storeGroupId: string | null;
  /** The name of a store the reviewer drafted inline; null when they chose one. */
  storeDraft: string | null;
  items: readonly ExistingItem[];
  groups: readonly LiveGroup[];
};

/** Where a line's item comes from: one the list has, or one this commit creates. */
export type ItemRef =
  { kind: 'existing'; id: string } | { kind: 'new'; normalizedName: string };

export type NewItem = { name: string; normalizedName: string };

export type LineWrite = {
  lineId: string;
  item: ItemRef;
  boundVia: 'created' | 'manual';
};

export type StorePlan =
  | { kind: 'existing'; groupId: string }
  | { kind: 'new'; name: string; normalizedName: string };

export type AliasLearning = {
  lineId: string;
  item: ItemRef;
  aliasText: string;
  normalizedAlias: string;
};

export type CommitPlan = {
  /** The catalog items this commit creates, in the order the lines ask for them. */
  newItems: NewItem[];
  /** The lines that leave `new` for their materialized binding. */
  lineWrites: LineWrite[];
  store: StorePlan;
  /** The aliases the reviewed printed text teaches, one per phrase and item. */
  aliases: AliasLearning[];
  /**
   * Whether the commit created a snapshot-visible row (a catalog item or a store
   * group). Receipts and aliases stay out of the snapshot, so a commit that only
   * bound existing rows must not move `app_state.revision`.
   */
  createsEntities: boolean;
};

/**
 * Decide what one commit writes, or refuse it. The refusals are HTTP-shaped
 * (400/409) because the gate is the API contract; nothing is written by a
 * refusal, since the service plans before it writes anything.
 */
export function planReceiptCommit(input: CommitPlanInput): CommitPlan {
  const itemLines = input.lines.filter((line) => line.isItemChunk);
  requireEveryItemLineDecided(itemLines);
  const store = resolveStore(input);
  const drafts = readItemDrafts(itemLines, input.itemDrafts);

  const newItems: NewItem[] = [];
  const lineWrites: LineWrite[] = [];
  const aliases: AliasLearning[] = [];
  const learned = new Set<string>();

  for (const line of itemLines) {
    const item = itemForLine(line, drafts, input.items, newItems);
    if (item && line.reviewState === 'new') {
      lineWrites.push({
        lineId: line.id,
        item,
        boundVia: item.kind === 'existing' ? 'manual' : 'created',
      });
    }

    const learning = aliasForLine(line, item, learned);
    if (learning) aliases.push(learning);
  }

  return {
    newItems,
    lineWrites,
    store,
    aliases,
    createsEntities: newItems.length > 0 || store.kind === 'new',
  };
}

/** Every item line must have left `unreviewed`; parked rows are parser-settled. */
function requireEveryItemLineDecided(
  itemLines: readonly CommittableLine[],
): void {
  const unreviewed = itemLines.filter(
    (line) => line.reviewState === 'unreviewed',
  );
  if (unreviewed.length === 0) return;

  throw new AppError(
    400,
    'RECEIPT_NOT_REVIEWED',
    'Review every item line before committing this receipt.',
    { details: { lineIds: unreviewed.map((line) => line.id) } },
  );
}

/**
 * Where the receipt's store comes from: the group the reviewer chose, the store
 * they drafted, or a refusal. A drafted name that matches a live group reuses it
 * when it is a store — a name collision is the same thing as choosing it — and
 * refuses when the name is taken by a category, which the groups' live-name
 * uniqueness would not let a new store carry either.
 */
function resolveStore(input: CommitPlanInput): StorePlan {
  const draft = input.storeDraft?.trim() ?? '';
  if (draft && input.storeGroupId) {
    throw badRequest(
      'INVALID_STORE',
      'Choose a store or create one, not both.',
    );
  }

  if (draft) {
    const normalizedName = normalizeName(draft);
    const collision = input.groups.find(
      (group) => group.normalizedName === normalizedName,
    );
    if (collision?.kind === 'store') {
      return { kind: 'existing', groupId: collision.id };
    }
    if (collision) {
      throw conflict(
        'GROUP_NAME_EXISTS',
        'A group with this name already exists.',
        {
          groupId: collision.id,
        },
      );
    }
    return { kind: 'new', name: draft, normalizedName };
  }

  if (!input.storeGroupId) {
    throw badRequest(
      'RECEIPT_STORE_REQUIRED',
      'Choose the store this receipt is from before committing.',
    );
  }

  const group = input.groups.find((live) => live.id === input.storeGroupId);
  if (!group || group.kind !== 'store') {
    throw new AppError(
      400,
      'INVALID_STORE',
      'Choose a store group from this list.',
      { fieldErrors: { storeGroupId: ['Choose a store group.'] } },
    );
  }
  return { kind: 'existing', groupId: group.id };
}

/** The names of the lines drafting a new item; a draft for any other line is a bug. */
function readItemDrafts(
  itemLines: readonly CommittableLine[],
  drafts: readonly ItemDraft[],
): Map<string, string> {
  const byLine = new Map<string, string>();
  for (const draft of drafts) {
    const line = itemLines.find((candidate) => candidate.id === draft.lineId);
    if (!line || line.reviewState !== 'new') {
      throw badRequest(
        'INVALID_LINE',
        'Only a line drafting a new item can name one.',
      );
    }
    byLine.set(draft.lineId, draft.name.trim());
  }
  return byLine;
}

/**
 * The item a line ends up on: the binding it already has, the item its draft
 * names (created if the list has no item by that name), or nothing — an
 * `unknown` or `skipped` line stays an observation.
 */
function itemForLine(
  line: CommittableLine,
  drafts: ReadonlyMap<string, string>,
  items: readonly ExistingItem[],
  newItems: NewItem[],
): ItemRef | null {
  if (line.reviewState === 'bound') {
    return line.catalogItemId
      ? { kind: 'existing', id: line.catalogItemId }
      : null;
  }
  if (line.reviewState !== 'new') return null;

  const name = drafts.get(line.id);
  if (!name) {
    throw badRequest(
      'INVALID_LINE',
      'A new item needs a name before committing.',
    );
  }

  const normalizedName = normalizeName(name);
  const existing = items.find((item) => item.normalizedName === normalizedName);
  if (existing) return { kind: 'existing', id: existing.id };

  if (!newItems.some((item) => item.normalizedName === normalizedName)) {
    newItems.push({ name, normalizedName });
  }
  return { kind: 'new', normalizedName };
}

/**
 * The alias one line teaches: its reviewed printed text, for the item it ended
 * up on. One phrase is learned once per item — two lines printing the same thing
 * do not fight over the same row.
 */
function aliasForLine(
  line: CommittableLine,
  item: ItemRef | null,
  learned: Set<string>,
): AliasLearning | null {
  if (!item) return null;
  const aliasText = line.rawText.trim();
  const normalizedAlias = normalizeName(aliasText);
  if (!normalizedAlias) return null;

  const key = `${itemKey(item)}:${normalizedAlias}`;
  if (learned.has(key)) return null;
  learned.add(key);

  return { lineId: line.id, item, aliasText, normalizedAlias };
}

function itemKey(item: ItemRef): string {
  return item.kind === 'existing' ? item.id : `new:${item.normalizedName}`;
}
