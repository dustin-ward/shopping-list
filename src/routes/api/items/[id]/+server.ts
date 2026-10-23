import type { RequestHandler } from './$types';
import { renameItemSchema } from '../../../../lib/shared/schemas';
import {
  apiErrorResponse,
  jsonNoStore,
  parseJson,
} from '../../../../lib/server/errors';
import { renameItem } from '../../../../lib/server/services/items';

// Rename the household term. `expectedName` is the stale-view guard: the
// catalogue row has no revision, and the name is what the snapshot shows.
export const PATCH: RequestHandler = async ({ params, request }) => {
  try {
    const input = await parseJson(request, renameItemSchema);
    return jsonNoStore(renameItem(params.id, input));
  } catch (error) {
    return apiErrorResponse(error);
  }
};
