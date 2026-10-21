import type { RequestHandler } from './$types';
import { apiErrorResponse, jsonNoStore } from '../../../lib/server/errors';
import { listUnknownLines } from '../../../lib/server/services/unknowns';

// The grouped browser's read (ticket 17): unknown lines grouped by normalized
// printed text across committed receipts, with the counts and money that make
// the same payload the unidentified-spending view. No payload — the list is the
// whole scope, and receipt data never enters the snapshot.
export const GET: RequestHandler = () => {
  try {
    return jsonNoStore(listUnknownLines());
  } catch (error) {
    return apiErrorResponse(error);
  }
};
