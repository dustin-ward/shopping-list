import type { RequestHandler } from './$types';
import { addEntrySchema } from '../../../lib/shared/schemas';
import {
  apiErrorResponse,
  jsonNoStore,
  parseJson,
} from '../../../lib/server/errors';
import { addEntry } from '../../../lib/server/services/entries';

export const POST: RequestHandler = async ({ request }) => {
  try {
    const input = await parseJson(request, addEntrySchema);
    return jsonNoStore(addEntry(input), { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
};
