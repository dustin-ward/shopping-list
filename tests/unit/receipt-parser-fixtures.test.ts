import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readOcrLines } from '../../src/lib/server/receipts/indra-layout';
import {
  parseReceiptOcr,
  type ParsedReceipt,
} from '../../src/lib/server/receipts/parser';

/**
 * Golden fixtures captured from the real sidecar (see the ticket comment for
 * provenance). Each `<stem>.json` is an actual Indra payload for the committed
 * `<stem>.png`; each `<stem>.expected.json` is the parse this parser is
 * expected to produce, including the parked rows and the warnings. The pair is
 * what makes a parser change visible: a diff here is a behavior change, not a
 * refactor.
 */
const FIXTURES = join(process.cwd(), 'tests/fixtures/receipts');

const STEMS = [
  'clean-grocery',
  'wrapped-two-column',
  'coupons-negatives',
  'washed-out',
] as const;

/**
 * The persisted projection: exactly the fields the worker writes to
 * `receipt_lines` plus the receipt totals. `sourceLineIndexes` is deliberately
 * left out — it is the parser's bookkeeping and shifts with any regrouping —
 * and asserted separately by the no-loss test.
 */
function persistedProjection(parsed: ParsedReceipt) {
  return {
    parseVersion: parsed.parseVersion,
    lines: parsed.lines.map((line) => ({
      isItemChunk: line.isItemChunk,
      rawText: line.rawText,
      parsedName: line.parsedName,
      quantityReal: line.quantityReal,
      quantityText: line.quantityText,
      quantityUnit: line.quantityUnit,
      unitPriceMinor: line.unitPriceMinor,
      totalPriceMinor: line.totalPriceMinor,
      confidence: line.confidence,
    })),
    subtotalMinor: parsed.subtotalMinor,
    taxMinor: parsed.taxMinor,
    totalMinor: parsed.totalMinor,
    deltaMinor: parsed.deltaMinor,
    warnings: parsed.warnings,
  };
}

function readFixture(stem: string, suffix: string): string {
  return readFileSync(join(FIXTURES, `${stem}${suffix}`), 'utf8');
}

describe('golden fixtures', () => {
  it.each(STEMS)('%s parses to its committed golden output', (stem) => {
    const parsed = parseReceiptOcr(readFixture(stem, '.json'));
    const expected = JSON.parse(readFixture(stem, '.expected.json')) as unknown;

    expect(persistedProjection(parsed)).toEqual(expected);
  });

  it.each(STEMS)('%s accounts for every text line exactly once', (stem) => {
    const raw = readFixture(stem, '.json');
    const read = readOcrLines(raw);
    expect(read).not.toBeNull();

    const textIndexes = (read?.lines ?? [])
      .filter((line) => line.text.trim())
      .map((line) => line.index);
    const consumed = parseReceiptOcr(raw).lines.flatMap(
      (line) => line.sourceLineIndexes,
    );

    expect([...consumed].sort((a, b) => a - b)).toEqual(
      [...textIndexes].sort((a, b) => a - b),
    );
    expect(new Set(consumed).size).toBe(consumed.length);
  });

  it.each(STEMS)('%s reports a delta the review UI can recompute', (stem) => {
    const parsed = parseReceiptOcr(readFixture(stem, '.json'));
    const itemTotal = parsed.lines.reduce(
      (sum, line) => sum + (line.isItemChunk ? (line.totalPriceMinor ?? 0) : 0),
      0,
    );
    const reference = parsed.subtotalMinor ?? parsed.totalMinor;

    if (reference === null || !parsed.lines.some((line) => line.isItemChunk)) {
      expect(parsed.deltaMinor).toBeNull();
      return;
    }
    expect(parsed.deltaMinor).toBe(itemTotal - reference);
  });
});
