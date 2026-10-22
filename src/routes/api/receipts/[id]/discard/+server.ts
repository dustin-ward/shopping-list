import type { RequestHandler } from './$types';
import { serverInstanceMutationSchema } from '../../../../../lib/shared/schemas';
import {
  apiErrorResponse,
  jsonNoStore,
  parseJson,
} from '../../../../../lib/server/errors';
import { discardReceipt } from '../../../../../lib/server/services/receipts';

// The route names the receipt; the payload carries the instance guard from the
// client's last verified snapshot. The service accepts every non-committed status.
export const POST: RequestHandler = async ({ params, request }) => {
  try {
    const input = await parseJson(request, serverInstanceMutationSchema);
    return jsonNoStore(discardReceipt(params.id, input));
  } catch (error) {
    return apiErrorResponse(error);
  }
};
