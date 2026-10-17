import type { RequestHandler } from './$types';
import {
  apiErrorResponse,
  jsonNoStore,
} from '../../../../../lib/server/errors';
import { retryReceipt } from '../../../../../lib/server/services/receipt-worker';

// Manual retry carries no payload: the receipt id is the whole input, and the
// service accepts exactly one transition, `failed` → `pending`.
export const POST: RequestHandler = ({ params }) => {
  try {
    return jsonNoStore(retryReceipt(params.id));
  } catch (error) {
    return apiErrorResponse(error);
  }
};
