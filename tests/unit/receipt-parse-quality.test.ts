import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LOW_RECEIPT_CONFIDENCE,
  assessParseQuality,
} from '../../src/lib/server/receipts/parse-quality';
import { parseReceiptOcr } from '../../src/lib/server/receipts/parser';
import { HELPER_REPARSE_WARNING } from '../../src/lib/shared/receipt-helper';

/**
 * Low-confidence detection is what decides whether the review screen offers
 * "re-parse with helper". The four committed fixtures are the evidence we have:
 * three clean parses that must stay quiet, and the washed-out receipt, whose
 * missing price column and missing footer are exactly the R4 trigger.
 */
const FIXTURES = join(process.cwd(), 'tests/fixtures/receipts');

function fixture(name: string) {
  const parsed = parseReceiptOcr(
    readFileSync(join(FIXTURES, `${name}.json`), 'utf8'),
  );
  return { parsed, quality: assessParseQuality(parsed) };
}

describe('assessParseQuality', () => {
  it.each(['clean-grocery', 'wrapped-two-column', 'coupons-negatives'])(
    '%s parses with enough confidence that no helper is offered',
    (name) => {
      const { quality } = fixture(name);

      expect(quality.lowConfidence).toBe(false);
      expect(quality.reasons).toEqual([]);
      expect(quality.helperApplied).toBe(false);
    },
  );

  it('flags the washed-out receipt for the missing price column and footer', () => {
    const { quality } = fixture('washed-out');

    expect(quality.lowConfidence).toBe(true);
    expect(quality.reasons).toEqual([
      'no price column was found',
      'no subtotal or total was found',
    ]);
  });

  it('names a receipt with no item lines as low-confidence', () => {
    const quality = assessParseQuality({
      lines: [
        {
          isItemChunk: false,
          confidence: 0.99,
        },
      ],
      subtotalMinor: 1000,
      totalMinor: 1000,
      warnings: [],
    });

    expect(quality.lowConfidence).toBe(true);
    expect(quality.reasons).toContain('no item lines were found');
  });

  it('flags item lines whose mean confidence is under the threshold', () => {
    const quality = assessParseQuality({
      lines: [
        { isItemChunk: true, confidence: 0.4 },
        { isItemChunk: true, confidence: 0.5 },
        { isItemChunk: false, confidence: 1 },
      ],
      subtotalMinor: 900,
      totalMinor: 900,
      warnings: [],
    });

    expect(quality.lowConfidence).toBe(true);
    expect(quality.reasons).toEqual([
      `item lines were read at low confidence (under ${Math.round(
        LOW_RECEIPT_CONFIDENCE * 100,
      )}%)`,
    ]);
  });

  it('leaves the mean exactly at the threshold alone', () => {
    const quality = assessParseQuality({
      lines: [
        { isItemChunk: true, confidence: LOW_RECEIPT_CONFIDENCE },
        { isItemChunk: true, confidence: LOW_RECEIPT_CONFIDENCE },
      ],
      subtotalMinor: 900,
      totalMinor: 900,
      warnings: [],
    });

    expect(quality.lowConfidence).toBe(false);
  });

  it('treats missing per-line confidence as unknown rather than low', () => {
    const quality = assessParseQuality({
      lines: [{ isItemChunk: true, confidence: null }],
      subtotalMinor: 900,
      totalMinor: 900,
      warnings: [],
    });

    expect(quality.lowConfidence).toBe(false);
  });

  it('marks a helper-produced parse as already helped', () => {
    const quality = assessParseQuality({
      lines: [{ isItemChunk: true, confidence: 0.9 }],
      subtotalMinor: 900,
      totalMinor: 900,
      warnings: [HELPER_REPARSE_WARNING],
    });

    expect(quality.helperApplied).toBe(true);
  });

  it('does not mistake a deterministic parse for helped output', () => {
    const quality = assessParseQuality({
      lines: [{ isItemChunk: true, confidence: 0.9 }],
      subtotalMinor: 900,
      totalMinor: 900,
      warnings: [],
    });

    expect(quality.helperApplied).toBe(false);
  });

  it('treats a never-parsed receipt (no warnings) as unknown, not low', () => {
    const quality = assessParseQuality({
      lines: [],
      subtotalMinor: null,
      totalMinor: null,
      warnings: null,
    });

    expect(quality.lowConfidence).toBe(false);
    expect(quality.reasons).toEqual([]);
  });
});
