import type { RequestHandler } from './$types';
import { renameGroupSchema } from '../../../../lib/shared/schemas';
import {
  apiErrorResponse,
  jsonNoStore,
  parseJson,
} from '../../../../lib/server/errors';
import { renameGroup } from '../../../../lib/server/services/groups';

export const PATCH: RequestHandler = async ({ params, request }) => {
  try {
    const input = await parseJson(request, renameGroupSchema);
    return jsonNoStore(renameGroup(params.id, input));
  } catch (error) {
    return apiErrorResponse(error);
  }
};
