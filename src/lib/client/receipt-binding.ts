/**
 * The binding layer's client half (plan §10 review editor): what a tap on a
 * suggestion chip, a pick from the item search, or an inline-created item or
 * store means as a review edit.
 *
 * Bound lines and store choices are ordinary review edits — they travel the
 * `PATCH` route ticket 11 built, carrying the same `updatedAt` guard as any
 * other edit. An inline-created item or store is only a *draft*: it exists in
 * the editor until commit (ticket 13) materializes it, so nothing here can
 * write a catalog or group row early.
 */

import { normalizeName } from '../shared/normalize';
import type {
  ReceiptDetailLine,
  ReceiptLinePatch,
  ReceiptSuggestion,
} from '../shared/schemas';
import { suggestionIsBound } from './receipt-display';

/** A household item the item picker can offer. */
export type CatalogItemOption = { id: string; name: string };

/**
 * A household group — the shape the snapshot carries. A receipt can only ever
 * be bound to one of `kind: 'store'`, which is why the store picker takes these
 * and the editor filters them.
 */
export type GroupOption = {
  id: string;
  name: string;
  kind: 'store' | 'category';
};

/**
 * How many hits a name search shows. Five is the ceiling the suggester puts on a
 * line's candidates (`matcher.ts`), and the same is plenty here: a household's
 * item list is short, and the row has to stay readable. (The client cannot
 * import the server's constant — `$lib/server` never ships to the browser.)
 */
const MAX_ITEM_MATCHES = 5;

/**
 * A name shorter than this is too generic to recognise a store by — the prefill
 * exists to save typing, never to guess (`ADR 0003`).
 */
const MIN_STORE_NAME_LENGTH = 3;

/**
 * A suggestion chip's rank on its line: the detail payload's candidates arrive
 * in rank order, so the accepted one's 1-based position *is* the rank the schema
 * records for telemetry. `null` when the candidate is not on this line.
 */
export function suggestionRank(
  line: Pick<ReceiptDetailLine, 'suggestions'>,
  catalogItemId: string,
): number | null {
  const index = line.suggestions.findIndex(
    (suggestion) => suggestion.catalogItemId === catalogItemId,
  );
  return index === -1 ? null : index + 1;
}

/**
 * Tap one chip: bind the line to that candidate with `suggested` provenance and
 * the accepted rank — or, when the line already sits on the candidate, reject
 * that binding and leave the line for the reviewer to decide again.
 */
export function suggestionEdit(
  line: ReceiptDetailLine,
  suggestion: ReceiptSuggestion,
): ReceiptLinePatch | null {
  if (suggestionIsBound(line, suggestion)) return releaseEdit();
  const rank = suggestionRank(line, suggestion.catalogItemId);
  if (rank === null) return null;
  return {
    reviewState: 'bound',
    catalogItemId: suggestion.catalogItemId,
    boundVia: 'suggested',
    boundRank: rank,
  };
}

/**
 * Picking an item in the search: the plan's tier 3, "search + create". Even when
 * the pick lands on the candidate the picker prefigured, the reviewer found it
 * here rather than tapping a suggestion, so it is a `manual` bind with no rank —
 * the accepted-suggestion rank is what the search telemetry tells apart.
 */
export function bindItemEdit(catalogItemId: string): ReceiptLinePatch {
  return {
    reviewState: 'bound',
    catalogItemId,
    boundVia: 'manual',
    boundRank: null,
  };
}

/** Release a line: back to `unreviewed`, which clears its item and provenance. */
export function releaseEdit(): ReceiptLinePatch {
  return { reviewState: 'unreviewed' };
}

/**
 * Draft a new item. The *state* persists (the line has left `unreviewed`, which
 * is what the commit gate asks about); the name is the reviewer's and stays in
 * the editor until commit — nothing is created before then. Its starting name is
 * the parser's (`parsed_name`, minus the junk the parser already dropped), never
 * whatever was typed into the search box: a query is not a name.
 */
export function draftItemEdit(
  line: Pick<ReceiptDetailLine, 'parsedName' | 'rawText'>,
): { patch: ReceiptLinePatch; name: string } {
  return { patch: { reviewState: 'new' }, name: itemDraftName(line) };
}

/** The name a draft starts from: the parser's name, then the printed text. */
export function itemDraftName(
  line: Pick<ReceiptDetailLine, 'parsedName' | 'rawText'>,
): string {
  return line.parsedName?.trim() || line.rawText.trim();
}

/**
 * What the item picker's search box starts with: the line's top candidate, so
 * the best guess is one tap away — never a binding on its own. Only a line the
 * reviewer has not decided shows it; a line they marked unknown or skipped is
 * their call, and prefilling a guess there would argue with it.
 */
export function itemPickerPrefill(
  line: Pick<ReceiptDetailLine, 'reviewState' | 'suggestions'>,
): string {
  if (line.reviewState !== 'unreviewed') return '';
  return line.suggestions[0]?.name.trim() ?? '';
}

/** The items whose names contain what the reviewer typed, alphabetically. */
export function filterItems(
  items: readonly CatalogItemOption[],
  typed: string,
): CatalogItemOption[] {
  const query = normalizeName(typed);
  if (!query) return [];
  return items
    .filter((item) => normalizeName(item.name).includes(query))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_ITEM_MATCHES);
}

/**
 * The store the picker offers before the reviewer chooses one: the store group
 * whose name the receipt's own text carries. The longest name wins ("Corner
 * Market" over "Market"), and nothing is offered unless the name is really
 * printed somewhere on the receipt — a guess here would be a silent
 * mis-binding, which ADR 0003 rules out.
 */
export function storePrefill(
  lines: readonly { rawText: string }[],
  stores: readonly GroupOption[],
): GroupOption | null {
  const receiptText = normalizeName(
    lines.map((line) => line.rawText).join(' '),
  );
  if (!receiptText) return null;

  let best: GroupOption | null = null;
  let bestLength = 0;
  for (const store of stores) {
    const name = normalizeName(store.name);
    if (name.length < MIN_STORE_NAME_LENGTH) continue;
    if (!mentions(receiptText, name)) continue;
    if (name.length > bestLength) {
      best = store;
      bestLength = name.length;
    }
  }
  return best;
}

/** Whether a normalized phrase appears in the text as whole words. */
function mentions(text: string, phrase: string): boolean {
  return ` ${text} `.includes(` ${phrase} `);
}
