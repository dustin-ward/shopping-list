import type { RequestHandler } from './$types';
import { commitReceiptSchema } from '../../../../../lib/shared/schemas';
import {
  apiErrorResponse,
  jsonNoStore,
  parseJson,
} from '../../../../../lib/server/errors';
import { commitReceipt } from '../../../../../lib/server/services/receipts';

// Commit carries the reviewer's drafts — the draft item names and a drafted
// store name live only in the editor until this request materializes them —
// alongside the `updatedAt` guard the review edits use.
export const POST: RequestHandler = async ({ params, request }) => {
  try {
    const input = await parseJson(request, commitReceiptSchema);
    return jsonNoStore(commitReceipt(params.id, input));
  } catch (error) {
    return apiErrorResponse(error);
  }
};
