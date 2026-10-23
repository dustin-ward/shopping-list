/**
 * The receipt reconciliation arithmetic (plan §6, "money hygiene"), shared by
 * the parser — which warns about it in `ocr_warnings` at parse time — and the
 * receipt detail, which shows the same numbers in its totals strip.
 *
 * One implementation on purpose: the delta warning is a display hint, never a
 * gate, and the strip must not disagree with what the parser recorded.
 */

/** The delta is a hint, never a gate: quiet below max($0.05, 1% of the total). */
export const DELTA_WARNING_MIN_MINOR = 5;

/** The fields the arithmetic needs from a receipt line, whichever shape it is. */
export type TotalsLine = {
  isItemChunk: boolean;
  totalPriceMinor: number | null;
};

export type ReceiptTotalsInput = {
  lines: readonly TotalsLine[];
  subtotalMinor: number | null;
  taxMinor: number | null;
  totalMinor: number | null;
};

export type ReceiptTotals = {
  /** Σ of the item lines' totals; `null` when the receipt has no item lines. */
  itemsMinor: number | null;
  subtotalMinor: number | null;
  taxMinor: number | null;
  totalMinor: number | null;
  /** `Σ(items) − subtotal` (against the total when there is no subtotal). */
  deltaMinor: number | null;
  /** Which printed line the delta was measured against. */
  deltaReference: 'subtotal' | 'total' | null;
  /** Whether the delta is worth showing: above max($0.05, 1% of the total). */
  deltaWarns: boolean;
};

/** Σ of the item lines' totals; parked rows are never part of it. */
export function itemLinesTotalMinor(lines: readonly TotalsLine[]): number {
  return lines.reduce(
    (sum, line) => sum + (line.isItemChunk ? (line.totalPriceMinor ?? 0) : 0),
    0,
  );
}

/** Whether a delta is worth a warning: max($0.05, 1% of the receipt total). */
export function deltaExceedsThreshold(
  deltaMinor: number,
  referenceMinor: number,
): boolean {
  const threshold = Math.max(
    DELTA_WARNING_MIN_MINOR,
    Math.round(referenceMinor * 0.01),
  );
  return Math.abs(deltaMinor) > threshold;
}

/**
 * The strip's numbers: what the item lines add up to, the printed receipt
 * totals, and the gap between them. The delta is measured against the subtotal
 * when the receipt prints one (coupons and deposits are parked rows, so a
 * receipt that carries them reports the adjustment here) and it is worth
 * showing above max($0.05, 1% of the printed total), per spec §4.
 */
export function receiptTotals({
  lines,
  subtotalMinor,
  taxMinor,
  totalMinor,
}: ReceiptTotalsInput): ReceiptTotals {
  const hasItemLines = lines.some((line) => line.isItemChunk);
  const itemsMinor = hasItemLines ? itemLinesTotalMinor(lines) : null;
  const reference = subtotalMinor ?? totalMinor;
  const deltaMinor =
    itemsMinor === null || reference === null ? null : itemsMinor - reference;

  return {
    itemsMinor,
    subtotalMinor,
    taxMinor,
    totalMinor,
    deltaMinor,
    deltaReference:
      deltaMinor === null
        ? null
        : subtotalMinor !== null
          ? 'subtotal'
          : 'total',
    deltaWarns:
      deltaMinor !== null &&
      deltaExceedsThreshold(deltaMinor, totalMinor ?? subtotalMinor ?? 0),
  };
}
