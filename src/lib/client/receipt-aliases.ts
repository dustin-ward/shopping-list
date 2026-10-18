/**
 * The alias surface's client half (plan §7, "Learning loop"): which of an item's
 * aliases the reviewer sees, how a learned row describes itself, why a phrase
 * the list cannot resolve says so, and one sentence per refusal.
 *
 * The requests belong here too, beside the receipt client modules: the component
 * that renders the surface never calls `fetch` itself, and every rule it applies
 * to the payload is a pure function with its own test.
 */

import { ApiError, requestJson } from './api';
import type {
  AliasOverview,
  AliasSource,
  AmbiguousPhrase,
  ItemAlias,
  ItemAliases,
} from '../shared/schemas';

/**
 * The aliases of one item this view shows: the live ones, plus the soft-deleted
 * ones when the audit view is on. A deleted alias stays queryable — that is what
 * "soft" means — and showing it is the reviewer's deliberate choice.
 */
export function visibleAliases(
  item: ItemAliases,
  includeDeleted: boolean,
): ItemAlias[] {
  return includeDeleted
    ? [...item.aliases]
    : item.aliases.filter((alias) => !alias.deletedAt);
}

/** How many deleted aliases the whole list holds: the audit toggle's count. */
export function deletedAliasCount(overview: AliasOverview): number {
  return overview.items.reduce(
    (total, item) =>
      total + item.aliases.filter((alias) => alias.deletedAt).length,
    0,
  );
}

/** How a learned row says where it came from. */
export function aliasSourceLabel(source: AliasSource): string {
  switch (source) {
    case 'manual':
      return 'Confirmed by hand';
    case 'auto':
      return 'Learned automatically';
    default:
      return 'Learned in review';
  }
}

/**
 * Why a phrase is listed as ambiguous, in the reviewer's words: naming every
 * claiming item is the point — matching asked because it will not pick between
 * them (`ADR 0003`).
 */
export function ambiguitySentence(phrase: AmbiguousPhrase): string {
  return `${phrase.phrase} is claimed by ${nameList(
    phrase.items.map((item) => item.name),
  )} — matching asks instead of guessing.`;
}

/** A, B and C — the list joined the way a sentence reads. */
function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The alias surface's read: every alias of this list, grouped per item. */
export function fetchAliasOverview(): Promise<AliasOverview> {
  return requestJson<AliasOverview>('/api/aliases');
}

/**
 * Soft-delete one alias. The payload is an empty object on purpose: the route
 * takes no input, and the server hook only lets a JSON content type through.
 * The answer is the fresh overview, so the surface replaces its copy wholesale
 * — which is also how a resolved ambiguity disappears from the report.
 */
export function submitAliasDelete(aliasId: string): Promise<AliasOverview> {
  return requestJson<AliasOverview>(`/api/aliases/${aliasId}/delete`, {
    method: 'POST',
    body: {},
  });
}

/** One sentence for every refusal a delete can meet. */
export function aliasDeleteErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'The alias could not be deleted. Try again.';
  }
  if (error.code === 'NOT_FOUND') {
    return 'That alias no longer exists — the list has been refreshed.';
  }
  return error.message;
}
