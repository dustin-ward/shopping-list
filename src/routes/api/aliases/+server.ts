import type { RequestHandler } from './$types';
import { apiErrorResponse, jsonNoStore } from '../../../lib/server/errors';
import { listAliases } from '../../../lib/server/services/aliases';

// The alias surface's read: every learned alias grouped per item (deleted rows
// included, for the audit view) plus the phrases two items claim. No payload —
// the list is the whole scope.
export const GET: RequestHandler = () => {
  try {
    return jsonNoStore(listAliases());
  } catch (error) {
    return apiErrorResponse(error);
  }
};
