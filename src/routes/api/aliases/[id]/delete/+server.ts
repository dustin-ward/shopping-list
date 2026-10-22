import type { RequestHandler } from './$types';
import { deleteAliasSchema } from '../../../../../lib/shared/schemas';
import {
  apiErrorResponse,
  jsonNoStore,
  parseJson,
} from '../../../../../lib/server/errors';
import { deleteAlias } from '../../../../../lib/server/services/aliases';

// Soft-delete one alias. The alias id names the row; the payload carries the
// instance guard from the client's last verified snapshot, so a delete sent to
// a restarted server is refused before it touches the row. The answer is the
// fresh overview, so the surface never has to patch its own copy.
export const POST: RequestHandler = async ({ params, request }) => {
  try {
    const input = await parseJson(request, deleteAliasSchema);
    return jsonNoStore(deleteAlias(params.id, input));
  } catch (error) {
    return apiErrorResponse(error);
  }
};
