/**
 * The unknown-line grouped browser's client half (ticket 17): what a group says
 * about the unidentified spending it holds, the deliberate second tap that binds
 * a whole wording, and one sentence per refusal.
 *
 * A group is a printed phrase and a bind is a deliberate correction across every
 * receipt that printed it, so the tap that chooses the item is not the tap that
 * writes — the reviewer sees how many lines will move and what matching will
 * learn first. The component that renders the surface never calls `fetch`
 * itself, and every sentence it applies to the payload is a pure function here.
 */

import { ApiError, requestJson } from './api';
import { formatMoney } from './money';
import type {
  UnknownLineGroup,
  UnknownLinesBindInput,
  UnknownLinesBindResult,
  UnknownLinesOverview,
} from '../shared/schemas';

/** `1 line`, `3 lines` — the count as a phrase, used in every sentence here. */
export function unknownLineCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'line' : 'lines'}`;
}

/**
 * The wording a group shows. A line can be unknown without printed text; it is
 * still unidentified spending, but there is no phrase to quote.
 */
export function unknownGroupLabel(group: UnknownLineGroup): string {
  return group.printedText.trim() || '(no printed text)';
}

/**
 * The view's headline: how much money is unidentified, spread over how many
 * wordings. This is the whole point of the surface doubling as the
 * unidentified-spending view — the count is what a reviewer can act on, the
 * amount is what it costs to leave it alone.
 */
export function unidentifiedSpendSummary(
  overview: UnknownLinesOverview,
): string {
  if (overview.lineCount === 0 || overview.groups.length === 0) {
    return 'No unidentified spending — every committed line has an item.';
  }
  const wordings = overview.groups.length;
  return `${unknownLineCountLabel(overview.lineCount)} across ${wordings} ${
    wordings === 1 ? 'wording' : 'wordings'
  } — ${formatMoney(overview.spendMinor, overview.currency)} unidentified.`;
}

/** What the confirm tap will do, before it does it. */
export function unknownBindQuestion(
  group: UnknownLineGroup,
  itemName: string,
): string {
  return `Bind ${unknownLineCountLabel(group.lineCount)} to ${itemName}? ${learnedAliasSentence(group, itemName)}`;
}

/** What a finished bind did, with the number the server actually changed. */
export function unknownBindNotice(
  group: UnknownLineGroup,
  itemName: string,
  boundLineCount: number,
): string {
  return `Bound ${unknownLineCountLabel(boundLineCount)} to ${itemName}. ${learnedAliasSentence(group, itemName)}`;
}

/** The unidentified-spending view. */
export function fetchUnknownLinesOverview(): Promise<UnknownLinesOverview> {
  return requestJson<UnknownLinesOverview>('/api/unknown-lines');
}

/**
 * Bind one grouped wording to an item. The group travels by its normalized
 * text, the key the browser already holds; the answer is the fresh view plus
 * the number of lines that actually moved, so a group another device emptied
 * first cannot make the surface claim work it did not do.
 */
export function submitUnknownBind(
  normalizedText: string,
  catalogItemId: string,
): Promise<UnknownLinesBindResult> {
  const input: UnknownLinesBindInput = { normalizedText, catalogItemId };
  return requestJson<UnknownLinesBindResult>('/api/unknown-lines/bind', {
    method: 'POST',
    body: input,
  });
}

/** One sentence for every refusal a batch bind can meet. */
export function unknownBindErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'The lines could not be bound. Try again.';
  }
  switch (error.code) {
    case 'NOT_FOUND':
      return 'That wording no longer has any unknown lines — the view has been refreshed.';
    case 'INVALID_ITEM':
      return 'That item is no longer in this list — refresh and pick another.';
    default:
      return error.message;
  }
}

/**
 * What the bind teaches matching. The empty phrasing has nothing to teach:
 * an empty alias would claim every line whose text reads as blank.
 */
function learnedAliasSentence(
  group: UnknownLineGroup,
  itemName: string,
): string {
  if (!group.normalizedText) {
    return 'The lines have no printed wording, so matching learns nothing.';
  }
  return `Matching will learn "${group.printedText}" for ${itemName}.`;
}
