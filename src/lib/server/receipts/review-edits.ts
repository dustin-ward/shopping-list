/**
 * What one line's review edit means, as pure data (plan §8 PATCH contract).
 *
 * The rules that keep the two halves of a binding consistent live here: a state
 * that holds no item carries no provenance, a bound line always has an item to
 * be bound to, and a rank only exists for an accepted suggestion. Reading the
 * patch this way means the service writes columns, it does not decide policy.
 */

import { badRequest } from '../errors';
import type {
  ReceiptLine,
  ReceiptLinePatch,
  ReceiptReviewState,
} from '../../shared/schemas';
import { reviewStateKeepsBinding } from '../../shared/receipt-review';

/** The editable columns of one stored line, as the service reads them. */
export type EditableLine = Pick<
  ReceiptLine,
  | 'rawText'
  | 'quantityReal'
  | 'quantityText'
  | 'quantityUnit'
  | 'unitPriceMinor'
  | 'totalPriceMinor'
  | 'reviewState'
  | 'catalogItemId'
  | 'boundVia'
  | 'boundRank'
>;

/**
 * Settle one line's edit against what is stored. Fields the patch omits keep
 * their stored value; a state that keeps no item clears the item and its
 * provenance, so a released line can never look bound.
 */
export function resolveLineEdit(
  line: EditableLine,
  patch: ReceiptLinePatch,
): EditableLine {
  const merged = mergeFields(line, patch);
  const reviewState: ReceiptReviewState = merged.reviewState;

  if (!reviewStateKeepsBinding(reviewState)) {
    if (
      patch.catalogItemId ||
      patch.boundVia !== undefined ||
      patch.boundRank !== undefined
    ) {
      throw badRequest(
        'INVALID_LINE_BINDING',
        'Only a bound line carries an item and its provenance.',
      );
    }
    return { ...merged, catalogItemId: null, boundVia: null, boundRank: null };
  }

  if (!merged.catalogItemId) {
    throw badRequest(
      'INVALID_LINE_BINDING',
      'A bound line needs a catalog item to bind to.',
    );
  }

  // Pointing the line at a different item makes the old provenance — and any
  // accepted suggestion's rank — describe a different item, so it is dropped
  // rather than inherited. Binding without naming a source is the reviewer.
  const rebound =
    patch.catalogItemId !== undefined &&
    patch.catalogItemId !== line.catalogItemId;
  const boundVia =
    patch.boundVia ?? (rebound ? 'manual' : (line.boundVia ?? 'manual'));
  const boundRank = patch.boundRank ?? (rebound ? null : merged.boundRank);
  if (boundVia !== 'suggested' && boundRank !== null) {
    throw badRequest(
      'INVALID_LINE_BINDING',
      'Only an accepted suggestion carries a rank.',
    );
  }

  return {
    ...merged,
    catalogItemId: merged.catalogItemId,
    boundVia,
    boundRank,
  };
}

/** The patch laid over the stored line: every edit, every untouched field kept. */
function mergeFields(
  line: EditableLine,
  patch: ReceiptLinePatch,
): EditableLine {
  return {
    rawText: patch.rawText ?? line.rawText,
    quantityReal: keep(patch.quantityReal, line.quantityReal),
    quantityText: keep(patch.quantityText, line.quantityText),
    quantityUnit: keep(patch.quantityUnit, line.quantityUnit),
    unitPriceMinor: keep(patch.unitPriceMinor, line.unitPriceMinor),
    totalPriceMinor: keep(patch.totalPriceMinor, line.totalPriceMinor),
    reviewState: patch.reviewState ?? line.reviewState,
    catalogItemId: keep(patch.catalogItemId, line.catalogItemId),
    boundVia: keep(patch.boundVia, line.boundVia),
    boundRank: keep(patch.boundRank, line.boundRank),
  };
}

/** An omitted field keeps its stored value; an explicit `null` clears it. */
function keep<T>(edited: T | undefined, stored: T): T {
  return edited === undefined ? stored : edited;
}
