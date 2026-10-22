import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/lib/client/api';
import {
  helperOffer,
  reparseErrorMessage,
  reparseReceiptInput,
} from '../../src/lib/client/receipt-helper';
import type {
  ReceiptDetail,
  ReceiptParseQuality,
} from '../../src/lib/shared/schemas';

/**
 * When the helper is offered, and what a refusal says. The rules are the R4
 * guard rails: only a low-confidence parse in review, only when the helper is
 * configured, and never on the helper's own output.
 */

function detail(
  quality: ReceiptParseQuality | null,
  overrides: Partial<ReceiptDetail> = {},
): Pick<ReceiptDetail, 'status' | 'parseQuality' | 'updatedAt'> {
  return {
    status: 'review',
    parseQuality: quality,
    updatedAt: '2026-10-17T12:00:00.000Z',
    ...overrides,
  };
}

const low: ReceiptParseQuality = {
  lowConfidence: true,
  helperApplied: false,
  reasons: ['no price column was found', 'no subtotal or total was found'],
};

describe('helperOffer', () => {
  it('offers the helper for a low-confidence parse in review', () => {
    expect(helperOffer(detail(low), true, true)).toEqual({
      reasons: low.reasons,
    });
  });

  it('says nothing when the helper is not configured', () => {
    expect(helperOffer(detail(low), false, true)).toBeNull();
  });

  it('says nothing for a parse with no quality data', () => {
    expect(helperOffer(detail(null), true, true)).toBeNull();
  });

  it('says nothing for a confident parse', () => {
    expect(
      helperOffer(
        detail({ lowConfidence: false, helperApplied: false, reasons: [] }),
        true,
        true,
      ),
    ).toBeNull();
  });

  it('says nothing when this device cannot write', () => {
    expect(helperOffer(detail(low), true, false)).toBeNull();
  });

  it('does not offer the helper on the helper’s own output', () => {
    expect(
      helperOffer(detail({ ...low, helperApplied: true }), true, true),
    ).toBeNull();
  });

  it('says nothing once the receipt has left review', () => {
    expect(
      helperOffer(detail(low, { status: 'committed' }), true, true),
    ).toBeNull();
  });
});

describe('reparseReceiptInput', () => {
  it('carries the guard token the reviewer last saw', () => {
    expect(reparseReceiptInput(detail(low))).toEqual({
      expectedUpdatedAt: '2026-10-17T12:00:00.000Z',
    });
  });
});

describe('reparseErrorMessage', () => {
  it('uses the server’s own sentence for a refused re-parse', () => {
    expect(
      reparseErrorMessage(
        new ApiError(
          503,
          'HELPER_DISABLED',
          'The fallback helper is not configured.',
        ),
      ),
    ).toBe('The fallback helper is not configured.');
  });

  it('falls back to a readable sentence for an unexpected failure', () => {
    expect(reparseErrorMessage(new Error('boom'))).toBe(
      'The helper could not re-read this receipt. Try again.',
    );
  });
});
