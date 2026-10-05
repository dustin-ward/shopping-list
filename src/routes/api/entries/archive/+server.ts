import type { RequestHandler } from './$types';
import { archiveEntriesSchema } from '../../../../lib/shared/schemas';
import {
  apiErrorResponse,
  jsonNoStore,
  parseJson,
} from '../../../../lib/server/errors';
import { archivePurchasedEntries } from '../../../../lib/server/services/entries';

export const POST: RequestHandler = async ({ request }) => {
  try {
    const input = await parseJson(request, archiveEntriesSchema);
    return jsonNoStore(archivePurchasedEntries(input));
  } catch (error) {
    return apiErrorResponse(error);
  }
};
