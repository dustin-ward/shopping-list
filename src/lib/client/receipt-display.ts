/**
 * How a parsed receipt line and its totals are shown: the projection the
 * receipt detail renders, kept pure so the committed fixtures can drive it.
 *
 * Every field the parser read is shown as it stands. The one fallback is a
 * line whose quantity was read without a canonical unit — there the verbatim
 * printed indicator is shown rather than a bare count, because a number on its
 * own is not what the receipt says.
 */

import type { ReceiptLine, ReceiptSuggestion } from '../shared/schemas';
import type { ReceiptTotals } from '../shared/receipt-totals';

/** The fields one rendered line needs; a parser line fits this shape too. */
export type ReceiptLineFields = Pick<
  ReceiptLine,
  | 'rawText'
  | 'parsedName'
  | 'quantityReal'
  | 'quantityText'
  | 'quantityUnit'
  | 'unitPriceMinor'
  | 'totalPriceMinor'
  | 'isItemChunk'
>;

export type ReceiptLineView = {
  printedText: string;
  /** The name the parser read; `null` only on a parked row. */
  parsedName: string | null;
  /** `2 ea`, `2.5 lb`, or the verbatim printed indicator. */
  quantity: string | null;
  unitPriceMinor: number | null;
  /** `/ea`, `/lb` … when the unit is known; `null` when it is not. */
  unitPriceSuffix: string | null;
  totalPriceMinor: number | null;
  /** A parked row: retained, but not something that was bought. */
  parked: boolean;
};

export function receiptLineView(line: ReceiptLineFields): ReceiptLineView {
  return {
    printedText: line.rawText.trim(),
    parsedName: line.parsedName?.trim() || null,
    quantity: quantityLabel(line),
    unitPriceMinor: line.unitPriceMinor,
    // A price per unit is `/ea`, `/lb` …; without a known unit it stands alone.
    unitPriceSuffix:
      line.unitPriceMinor === null || !line.quantityUnit
        ? null
        : `/${line.quantityUnit}`,
    totalPriceMinor: line.totalPriceMinor,
    parked: !line.isItemChunk,
  };
}

/** The count with its canonical unit, or the printed indicator verbatim. */
function quantityLabel(line: ReceiptLineFields): string | null {
  if (line.quantityReal === null) return line.quantityText?.trim() || null;
  if (line.quantityUnit) return `${line.quantityReal} ${line.quantityUnit}`;
  return line.quantityText?.trim() || String(line.quantityReal);
}

/**
 * The tier badges the review editor shows on a suggestion chip: the plan's
 * tier table in the reviewer's words, with the tier named so the choice is
 * legible (ticket 12 makes the chips tappable).
 */
export function suggestionTierBadge(tier: ReceiptSuggestion['tier']): {
  label: string;
  hint: string;
} {
  return tier === 1
    ? {
        label: 'Tier 1',
        hint: 'Matches the item name or an alias a human confirmed',
      }
    : {
        label: 'Tier 2',
        hint: 'A fuzzy suggestion — it is never bound without you',
      };
}

/** Whether the line already sits on this candidate (a tier-1 auto-bind). */
export function suggestionIsBound(
  line: Pick<ReceiptLine, 'catalogItemId' | 'reviewState'>,
  suggestion: Pick<ReceiptSuggestion, 'catalogItemId'>,
): boolean {
  return (
    line.reviewState === 'bound' &&
    line.catalogItemId === suggestion.catalogItemId
  );
}

/**
 * The Σ-delta warning for the totals strip, or `null` while the gap stays
 * within max($0.05, 1% of the total) — small differences are rounding, coupons
 * and deposits, and the reviewer is told about none of them.
 */
export function totalsWarningText(
  totals: ReceiptTotals,
  money: (minor: number) => string,
): string | null {
  const { deltaMinor, deltaReference, itemsMinor } = totals;
  if (deltaMinor === null || !totals.deltaWarns || itemsMinor === null) {
    return null;
  }
  const referenceMinor =
    deltaReference === 'subtotal' ? totals.subtotalMinor : totals.totalMinor;
  if (referenceMinor === null) return null;

  return `The item lines total ${money(itemsMinor)} but the ${
    deltaReference ?? 'total'
  } reads ${money(referenceMinor)} — a difference of ${money(
    Math.abs(deltaMinor),
  )}.`;
}
