import type { RequestHandler } from './$types';
import { reorderGroupsSchema } from '../../../../lib/shared/schemas';
import {
  apiErrorResponse,
  jsonNoStore,
  parseJson,
} from '../../../../lib/server/errors';
import { reorderGroups } from '../../../../lib/server/services/groups';

export const POST: RequestHandler = async ({ request }) => {
  try {
    const input = await parseJson(request, reorderGroupsSchema);
    return jsonNoStore(reorderGroups(input));
  } catch (error) {
    return apiErrorResponse(error);
  }
};
