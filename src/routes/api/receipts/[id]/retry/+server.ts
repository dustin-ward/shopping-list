import type { RequestHandler } from './$types';
import { serverInstanceMutationSchema } from '../../../../../lib/shared/schemas';
import {
  apiErrorResponse,
  jsonNoStore,
  parseJson,
} from '../../../../../lib/server/errors';
import { retryReceipt } from '../../../../../lib/server/services/receipt-worker';

// The route names the receipt; the payload carries the instance guard from the
// client's last verified snapshot. The service accepts exactly one transition,
// `failed` → `pending`.
export const POST: RequestHandler = async ({ params, request }) => {
  try {
    const input = await parseJson(request, serverInstanceMutationSchema);
    return jsonNoStore(retryReceipt(params.id, input));
  } catch (error) {
    return apiErrorResponse(error);
  }
};
