import type { RequestHandler } from './$types';
import {
  apiErrorResponse,
  jsonNoStore,
} from '../../../../../lib/server/errors';
import { discardReceipt } from '../../../../../lib/server/services/receipts';

// Discard takes no payload: the receipt id is the whole input, and the service
// accepts every non-committed status.
export const POST: RequestHandler = ({ params }) => {
  try {
    return jsonNoStore(discardReceipt(params.id));
  } catch (error) {
    return apiErrorResponse(error);
  }
};
