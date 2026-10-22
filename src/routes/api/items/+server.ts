import type { RequestHandler } from './$types';
import { apiErrorResponse, jsonNoStore } from '../../../lib/server/errors';
import { listItems } from '../../../lib/server/services/items';

// The item-management surface's read: every canonical item with the counts a
// merge has to move. Items already travel in the snapshot for the pickers, but
// their reference counts are an admin concern and stay out of that payload.
export const GET: RequestHandler = () => {
  try {
    return jsonNoStore(listItems());
  } catch (error) {
    return apiErrorResponse(error);
  }
};
