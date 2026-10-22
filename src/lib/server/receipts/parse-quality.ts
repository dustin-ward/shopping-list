/**
 * Is this parse worth a second reading? (plan §6, R4 fallback tier)
 *
 * The review screen offers "re-parse with helper" only when the first parse
 * looks like it struggled. The plan names the conditions — fewer than one price
 * column found, footer keywords absent, confidence under threshold — and this
 * module turns them into one answer from what was actually stored: the lines'
 * confidences, the receipt totals, and the parser's warnings. It is derived on
 * read, so it needs no schema of its own and a better parser changes it
 * immediately.
 *
 * A low-confidence parse is never a blocker and never rewrites anything: the
 * capture-first rule keeps the photo and the raw OCR JSON either way.
 */

import type { ReceiptParseQuality } from '../../shared/schemas';
import { HELPER_REPARSE_WARNING } from '../../shared/receipt-helper';
import { NO_PRICE_COLUMN_WARNING } from './parser';

/**
 * Mean item-line confidence below which the parse is called low-confidence.
 * Clean Indra parses sit in the 0.9s; this leaves room for one genuinely bad
 * line on an otherwise readable receipt.
 */
export const LOW_RECEIPT_CONFIDENCE = 0.7;

export type ParseQualityInput = {
  lines: readonly {
    isItemChunk: boolean;
    confidence: number | null;
  }[];
  subtotalMinor: number | null;
  totalMinor: number | null;
  /** The stored `ocr_warnings`; `null` means the receipt has never been parsed. */
  warnings: readonly string[] | null;
};

/** The three R4 triggers, in the order the review screen lists them. */
export function assessParseQuality(
  input: ParseQualityInput,
): ReceiptParseQuality {
  const helperApplied =
    input.warnings?.includes(HELPER_REPARSE_WARNING) ?? false;
  if (input.warnings === null) {
    return { lowConfidence: false, helperApplied, reasons: [] };
  }

  const reasons: string[] = [];
  if (input.warnings.includes(NO_PRICE_COLUMN_WARNING)) {
    reasons.push('no price column was found');
  }
  if (input.subtotalMinor === null && input.totalMinor === null) {
    reasons.push('no subtotal or total was found');
  }

  const itemConfidences = input.lines
    .filter((line) => line.isItemChunk)
    .map((line) => line.confidence)
    .filter((confidence): confidence is number => confidence !== null);

  if (!input.lines.some((line) => line.isItemChunk)) {
    reasons.push('no item lines were found');
  } else if (
    itemConfidences.length > 0 &&
    mean(itemConfidences) < LOW_RECEIPT_CONFIDENCE
  ) {
    reasons.push(
      `item lines were read at low confidence (under ${Math.round(
        LOW_RECEIPT_CONFIDENCE * 100,
      )}%)`,
    );
  }

  return { lowConfidence: reasons.length > 0, helperApplied, reasons };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
