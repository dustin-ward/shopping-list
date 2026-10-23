import type { RequestHandler } from './$types';
import { mergeItemsSchema } from '../../../../../lib/shared/schemas';
import {
  apiErrorResponse,
  jsonNoStore,
  parseJson,
} from '../../../../../lib/server/errors';
import { mergeItems } from '../../../../../lib/server/services/items';

// Merge the item in the path (the absorbed one) into the survivor named in the
// body. The answer carries the before/after counts that prove the move.
export const POST: RequestHandler = async ({ params, request }) => {
  try {
    const input = await parseJson(request, mergeItemsSchema);
    return jsonNoStore(mergeItems(params.id, input));
  } catch (error) {
    return apiErrorResponse(error);
  }
};
