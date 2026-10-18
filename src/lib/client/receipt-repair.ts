/**
 * The repair surface's client half (ticket 16): what a tap in repair mode means,
 * how the correction reaches the server, and one sentence per refusal.
 *
 * A repair is a binding edit and nothing else. The reviewer can bind the line to
 * any of the household's items, accept a suggestion, or mark the line unknown or
 * skipped — while the printed text, the quantities, the prices, the store, the
 * OCR text and the photo stay exactly as committed. Creating an item is not part
 * of it (items are managed on their own surface), and there is no `unreviewed` to
 * release to: a committed receipt's lines have all been decided.
 *
 * The taps that are *not* corrections are the point of the patches below: a state
 * the line already holds, the chip the line already sits on, and a pick of the
 * item it is already bound to all return `null`, so no request is made.
 */

import { requestJson, ApiError } from './api';
import { suggestionRank } from './receipt-binding';
import { suggestionIsBound } from './receipt-display';
import type { ReviewStateAction } from '../shared/receipt-review';
import type {
  ReceiptDetail,
  ReceiptDetailLine,
  ReceiptSuggestion,
  RepairLinePatch,
  RepairReceiptInput,
} from '../shared/schemas';

/** Mark the line unknown or skipped; the same state again is not a correction. */
export function repairStatePatch(
  line: Pick<ReceiptDetailLine, 'reviewState'>,
  action: ReviewStateAction,
): RepairLinePatch | null {
  return line.reviewState === action ? null : { reviewState: action };
}

/**
 * Accept a suggestion: the binding it names, with the accepted rank (the review
 * path's own rule). The chip the line already sits on is its current binding
 * rather than a correction — releasing is not something a repair can do.
 */
export function repairSuggestionPatch(
  line: ReceiptDetailLine,
  suggestion: ReceiptSuggestion,
): RepairLinePatch | null {
  if (suggestionIsBound(line, suggestion)) return null;
  const rank = suggestionRank(line, suggestion.catalogItemId);
  if (rank === null) return null;
  return {
    reviewState: 'bound',
    catalogItemId: suggestion.catalogItemId,
    boundVia: 'suggested',
    boundRank: rank,
  };
}

/** Bind the line to a picked item; picking the item it already sits on changes nothing. */
export function repairBindPatch(
  line: Pick<ReceiptDetailLine, 'catalogItemId'>,
  catalogItemId: string,
): RepairLinePatch | null {
  if (line.catalogItemId === catalogItemId) return null;
  return {
    reviewState: 'bound',
    catalogItemId,
    boundVia: 'manual',
    boundRank: null,
  };
}

/**
 * The repair request: the one line it corrects plus the `updatedAt` the editor
 * last saw — the same guard every review write carries, so a correction made
 * from a stale view is refused instead of landing on top of a newer one.
 */
export function repairReceiptInput(
  detail: Pick<ReceiptDetail, 'id' | 'updatedAt'>,
  lineId: string,
  patch: RepairLinePatch,
): RepairReceiptInput {
  return {
    expectedUpdatedAt: detail.updatedAt,
    lines: [{ id: lineId, ...patch }],
  };
}

/** Repair one committed receipt; the server answers with the receipt's new truth. */
export function submitReceiptRepair(
  receiptId: string,
  input: RepairReceiptInput,
): Promise<ReceiptDetail> {
  return requestJson<ReceiptDetail>(`/api/receipts/${receiptId}/repair`, {
    method: 'POST',
    body: input,
  });
}

/** One sentence for every refusal a repair can meet. */
export function repairErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'The repair could not be saved. Try again.';
  }
  switch (error.code) {
    case 'RECEIPT_NOT_COMMITTED':
      return 'Only a committed receipt can be repaired.';
    case 'RECEIPT_CHANGED':
      return 'This receipt changed on another device — the latest version is shown.';
    case 'INVALID_LINE':
      return 'Only an item line on this receipt can be repaired.';
    case 'NOT_FOUND':
      return 'That receipt no longer exists.';
    default:
      return error.message;
  }
}
