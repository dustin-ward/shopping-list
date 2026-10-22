/**
 * The fallback re-parse client half (plan §6, R4): should the review screen
 * offer the helper, what does the request carry, and what does a refusal say.
 *
 * The server decides whether a parse is low-confidence; this half only reads
 * that decision. Offering the helper is deliberately narrow — helper configured,
 * receipt in review, a parse the first pass struggled with, and never on the
 * helper's own output — so the default flow looks exactly as it did before.
 */

import { ApiError, requestJson } from './api';
import type { ReceiptDetail, ReparseReceiptInput } from '../shared/schemas';

/** What the offer says above its button: why this parse wants a second look. */
export type HelperOffer = {
  reasons: string[];
};

type OfferSource = Pick<ReceiptDetail, 'status' | 'parseQuality'>;

/**
 * The helper offer, or `null` when there is nothing to offer. A receipt that is
 * not in review cannot be re-parsed; a helper-disabled deployment has no engine
 * to call; a device that cannot write has no way to ask; and a parse that
 * already came from the helper is not offered again.
 */
export function helperOffer(
  detail: OfferSource,
  helperEnabled: boolean,
  writable: boolean,
): HelperOffer | null {
  if (!helperEnabled || !writable || detail.status !== 'review') return null;
  const quality = detail.parseQuality;
  if (!quality || !quality.lowConfidence || quality.helperApplied) return null;
  return { reasons: quality.reasons };
}

/**
 * The re-parse request. The `updatedAt` guard is the same one every review edit
 * carries: the helper replaces the lines, so a request built from a view that
 * has since moved on must be refused rather than throw away newer decisions.
 */
export function reparseReceiptInput(
  detail: Pick<ReceiptDetail, 'updatedAt'>,
): ReparseReceiptInput {
  return { expectedUpdatedAt: detail.updatedAt };
}

/** Hand the receipt's stored OCR evidence to the helper; the fresh detail comes back. */
export function submitReceiptReparse(
  receiptId: string,
  input: ReparseReceiptInput,
): Promise<ReceiptDetail> {
  return requestJson<ReceiptDetail>(`/api/receipts/${receiptId}/reparse`, {
    method: 'POST',
    body: input,
  });
}

/** One reader-facing sentence for a failed re-parse. */
export function reparseErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'The helper could not re-read this receipt. Try again.';
}
