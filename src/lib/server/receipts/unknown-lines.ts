/**
 * The grouped view of unknown lines (ticket 17; plan §13 "R2 — matching
 * maturity": the unknown-line grouped browser, "grouped by normalized printed
 * text; doubles as the recategorization surface").
 *
 * A group is a phrase, not a row: every committed item line the reviewer could
 * not identify whose printed wording normalizes the same. That is what lets the
 * surface be a spending view as well as a recategorization one — the count and
 * the money are per wording, and binding the wording empties its group
 * everywhere at once.
 *
 * The rules are pure and live here so they read without a database: the
 * normalization is the one aliases and item names already use, the
 * representative wording is the most recently committed line's (the freshest
 * printing), and the order is unidentified spend first, because that is the
 * number the view exists for. A line whose printed text normalizes to nothing
 * still counts as unidentified spending; it groups under the empty phrasing,
 * and the bind writes its lines without teaching an alias (there is no wording
 * to teach).
 */

import { normalizeName } from '../../shared/normalize';
import type { UnknownLinesOverview } from '../../shared/schemas';
import { phraseForLine } from './matcher';

/** One stored unknown line, as the grouping reads it. */
export type UnknownLineRow = {
  lineId: string;
  rawText: string;
  parsedName: string | null;
  totalPriceMinor: number | null;
  quantityReal: number | null;
  unitPriceMinor: number | null;
  receiptId: string;
  /** The commit time the query ordered by; missing only on hand-made rows. */
  committedAt: string | null;
  lineIndex: number;
};

/** One wording's unidentified lines: what the browser lists and a bind writes. */
export type UnknownLineGrouping = {
  normalizedText: string;
  printedText: string;
  /** The phrase matching reads for the representative line. */
  matchingPhrase: string;
  lineCount: number;
  receiptCount: number;
  spendMinor: number;
  /** The lines a batch bind writes, newest first; the first teaches the alias. */
  lineIds: string[];
  /** The receipts those lines belong to; a bind moves their guard token. */
  receiptIds: string[];
};

/**
 * Group unknown lines by normalized printed text, newest printing first inside
 * each group, biggest unidentified spend first between groups. The empty
 * phrasing is a group like any other: its lines are still unidentified spend,
 * even though no wording can be learned from them.
 */
export function groupUnknownLines(
  rows: readonly UnknownLineRow[],
): UnknownLineGrouping[] {
  const byText = new Map<string, UnknownLineGrouping>();

  for (const row of [...rows].sort(newestFirst)) {
    const normalizedText = normalizeName(row.rawText);
    const spendMinor = lineSpendMinor(row);

    const existing = byText.get(normalizedText);
    if (!existing) {
      byText.set(normalizedText, {
        normalizedText,
        printedText: row.rawText.trim(),
        matchingPhrase: phraseForLine(row).trim(),
        lineCount: 1,
        receiptCount: 1,
        spendMinor,
        lineIds: [row.lineId],
        receiptIds: [row.receiptId],
      });
      continue;
    }

    existing.lineCount += 1;
    existing.spendMinor += spendMinor;
    existing.lineIds.push(row.lineId);
    if (!existing.receiptIds.includes(row.receiptId)) {
      existing.receiptIds.push(row.receiptId);
      existing.receiptCount += 1;
    }
  }

  return [...byText.values()].sort(
    (left, right) =>
      right.spendMinor - left.spendMinor ||
      left.normalizedText.localeCompare(right.normalizedText),
  );
}

/** The browser's payload: the groups and the unidentified-spending totals. */
export function unknownLinesOverview(
  groups: readonly UnknownLineGrouping[],
  currency: string,
): UnknownLinesOverview {
  return {
    currency,
    groups: groups.map(
      ({
        normalizedText,
        printedText,
        lineCount,
        receiptCount,
        spendMinor,
      }) => ({
        normalizedText,
        printedText,
        lineCount,
        receiptCount,
        spendMinor,
      }),
    ),
    lineCount: groups.reduce((total, group) => total + group.lineCount, 0),
    spendMinor: groups.reduce((total, group) => total + group.spendMinor, 0),
  };
}

/**
 * What one line contributes to unidentified spending: its printed total, or —
 * when the price column was not read but the quantity form was — the extended
 * unit price. A line with neither adds nothing, as it does in the receipt's own
 * items total.
 */
function lineSpendMinor(row: UnknownLineRow): number {
  if (row.totalPriceMinor !== null) return row.totalPriceMinor;
  if (row.quantityReal !== null && row.unitPriceMinor !== null) {
    return Math.round(row.quantityReal * row.unitPriceMinor);
  }
  return 0;
}

/** Newest committed printing first; ties fall back to stable row identity. */
function newestFirst(left: UnknownLineRow, right: UnknownLineRow): number {
  return (
    (right.committedAt ?? '').localeCompare(left.committedAt ?? '') ||
    right.receiptId.localeCompare(left.receiptId) ||
    left.lineIndex - right.lineIndex ||
    left.lineId.localeCompare(right.lineId)
  );
}
