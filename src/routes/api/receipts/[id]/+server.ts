import type { RequestHandler } from './$types';
import { updateReceiptSchema } from '../../../../lib/shared/schemas';
import {
  apiErrorResponse,
  jsonNoStore,
  parseJson,
} from '../../../../lib/server/errors';
import {
  getReceiptDetail,
  updateReceipt,
} from '../../../../lib/server/services/receipts';

export const GET: RequestHandler = ({ params }) => {
  try {
    return jsonNoStore(getReceiptDetail(params.id));
  } catch (error) {
    return apiErrorResponse(error);
  }
};

export const PATCH: RequestHandler = async ({ params, request }) => {
  try {
    const input = await parseJson(request, updateReceiptSchema);
    return jsonNoStore(updateReceipt(params.id, input));
  } catch (error) {
    return apiErrorResponse(error);
  }
};
