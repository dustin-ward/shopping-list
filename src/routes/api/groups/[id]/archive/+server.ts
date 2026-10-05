import type { RequestHandler } from './$types';
import { entryRevisionSchema } from '../../../../../lib/shared/schemas';
import {
  apiErrorResponse,
  jsonNoStore,
  parseJson,
} from '../../../../../lib/server/errors';
import { archiveGroup } from '../../../../../lib/server/services/groups';

export const POST: RequestHandler = async ({ params, request }) => {
  try {
    const input = await parseJson(request, entryRevisionSchema);
    return jsonNoStore(archiveGroup(params.id, input));
  } catch (error) {
    return apiErrorResponse(error);
  }
};
