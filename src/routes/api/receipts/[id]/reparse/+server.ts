import type { RequestHandler } from './$types';
import { reparseReceiptSchema } from '../../../../../lib/shared/schemas';
import {
  apiErrorResponse,
  jsonNoStore,
  parseJson,
} from '../../../../../lib/server/errors';
import { reparseReceiptWithHelper } from '../../../../../lib/server/services/receipts';

// The R4 escape hatch: hand the receipt's immutable OCR evidence to the
// optional fallback helper and replace the parsed lines. Guarded by
// `expectedUpdatedAt` because the replacement discards line edits; the photo
// and raw OCR JSON stay exactly as they were.
export const POST: RequestHandler = async ({ params, request }) => {
  try {
    const input = await parseJson(request, reparseReceiptSchema);
    return jsonNoStore(await reparseReceiptWithHelper(params.id, input));
  } catch (error) {
    return apiErrorResponse(error);
  }
};
