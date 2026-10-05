import type { RequestHandler } from './$types';
import { apiErrorResponse, jsonNoStore } from '../../../lib/server/errors';
import { getPurchaseHistory } from '../../../lib/server/services/purchases';

export const GET: RequestHandler = ({ url }) => {
  try {
    return jsonNoStore(getPurchaseHistory(url.searchParams.get('cursor')));
  } catch (error) {
    return apiErrorResponse(error);
  }
};
