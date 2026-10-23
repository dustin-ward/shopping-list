import type { RequestHandler } from './$types';
import { unknownLinesBindSchema } from '../../../../lib/shared/schemas';
import {
  apiErrorResponse,
  jsonNoStore,
  parseJson,
} from '../../../../lib/server/errors';
import { bindUnknownLineGroup } from '../../../../lib/server/services/unknowns';

// Recategorize one grouped wording (ticket 17): every committed unknown line
// carrying that normalized phrase binds to the picked item in one transaction,
// and the wording is learned as an alias so the next receipt auto-binds. The
// answer is the fresh grouped view plus the count that actually moved, so the
// surface never patches its own copy.
export const POST: RequestHandler = async ({ request }) => {
  try {
    const input = await parseJson(request, unknownLinesBindSchema);
    return jsonNoStore(bindUnknownLineGroup(input));
  } catch (error) {
    return apiErrorResponse(error);
  }
};
