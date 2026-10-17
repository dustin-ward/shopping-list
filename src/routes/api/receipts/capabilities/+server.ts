import type { RequestHandler } from './$types';
import { apiErrorResponse, jsonNoStore } from '../../../../lib/server/errors';
import { getReceiptCapabilities } from '../../../../lib/server/services/receipts';

// Tells the client whether the receipt feature is enabled at all. Kept out of
// the snapshot (receipt data never enters it) and read per request.
export const GET: RequestHandler = () => {
  try {
    return jsonNoStore(getReceiptCapabilities());
  } catch (error) {
    return apiErrorResponse(error);
  }
};
