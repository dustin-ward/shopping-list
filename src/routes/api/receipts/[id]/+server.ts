import type { RequestHandler } from './$types';
import { apiErrorResponse, jsonNoStore } from '../../../../lib/server/errors';
import { getReceiptDetail } from '../../../../lib/server/services/receipts';

export const GET: RequestHandler = ({ params }) => {
  try {
    return jsonNoStore(getReceiptDetail(params.id));
  } catch (error) {
    return apiErrorResponse(error);
  }
};
