import type { RequestHandler } from './$types';
import { repairReceiptSchema } from '../../../../../lib/shared/schemas';
import {
  apiErrorResponse,
  jsonNoStore,
  parseJson,
} from '../../../../../lib/server/errors';
import { repairReceipt } from '../../../../../lib/server/services/receipts';

// The explicit repair mode ticket 16 adds: a route of its own, not a flag on the
// review PATCH (which stays review-only), and it takes only binding corrections —
// the printed text, the prices, the store and the raw artifacts stay committed.
// The answer is the receipt's new truth, so the repair surface never patches its
// own copy.
export const POST: RequestHandler = async ({ params, request }) => {
  try {
    const input = await parseJson(request, repairReceiptSchema);
    return jsonNoStore(repairReceipt(params.id, input));
  } catch (error) {
    return apiErrorResponse(error);
  }
};
