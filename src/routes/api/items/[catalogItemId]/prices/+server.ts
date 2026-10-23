import type { RequestHandler } from './$types';
import {
  apiErrorResponse,
  jsonNoStore,
} from '../../../../../lib/server/errors';
import { getItemPrices } from '../../../../../lib/server/services/prices';

// Price history for one canonical item, derived from committed receipt lines.
// Per-unit comparisons stay inside one measurement family; the read is
// on-demand like the other receipt surfaces and never enters the snapshot.
export const GET: RequestHandler = ({ params }) => {
  try {
    return jsonNoStore(getItemPrices(params.catalogItemId));
  } catch (error) {
    return apiErrorResponse(error);
  }
};
