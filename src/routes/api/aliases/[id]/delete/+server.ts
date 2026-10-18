import type { RequestHandler } from './$types';
import {
  apiErrorResponse,
  jsonNoStore,
} from '../../../../../lib/server/errors';
import { deleteAlias } from '../../../../../lib/server/services/aliases';

// Soft-delete one alias. The payload is empty on purpose: the alias id is the
// whole input, and the server hook only lets a JSON content type through. The
// answer is the fresh overview, so the surface never has to patch its own copy.
export const POST: RequestHandler = ({ params }) => {
  try {
    return jsonNoStore(deleteAlias(params.id));
  } catch (error) {
    return apiErrorResponse(error);
  }
};
