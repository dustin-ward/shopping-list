import type { RequestHandler } from './$types';
import { createGroupSchema } from '../../../lib/shared/schemas';
import {
  apiErrorResponse,
  jsonNoStore,
  parseJson,
} from '../../../lib/server/errors';
import { createGroup } from '../../../lib/server/services/groups';

export const POST: RequestHandler = async ({ request }) => {
  try {
    const input = await parseJson(request, createGroupSchema);
    return jsonNoStore(createGroup(input), { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
};
