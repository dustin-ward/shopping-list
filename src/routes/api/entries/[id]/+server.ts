import type { RequestHandler } from './$types';
import { editEntrySchema } from '../../../../lib/shared/schemas';
import {
  apiErrorResponse,
  jsonNoStore,
  parseJson,
} from '../../../../lib/server/errors';
import { editEntry } from '../../../../lib/server/services/entries';

export const PATCH: RequestHandler = async ({ params, request }) => {
  try {
    const input = await parseJson(request, editEntrySchema);
    return jsonNoStore(editEntry(params.id, input));
  } catch (error) {
    return apiErrorResponse(error);
  }
};
