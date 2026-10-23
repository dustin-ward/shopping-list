import type { RequestHandler } from './$types';
import { apiErrorResponse, jsonNoStore } from '../../../lib/server/errors';
import { listMatchingStats } from '../../../lib/server/services/matching-stats';

// Suggestion telemetry's read (ticket 18): the share of committed item lines by
// `bound_via` and the acceptance distribution by accepted suggestion rank. A
// read-only aggregate like the unknown-line browser, and like it, receipt data
// never enters the snapshot. No parameters — the committed corpus of this list
// is the whole scope.
export const GET: RequestHandler = () => {
  try {
    return jsonNoStore(listMatchingStats());
  } catch (error) {
    return apiErrorResponse(error);
  }
};
