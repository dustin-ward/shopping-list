import type { RequestHandler } from './$types';
import { apiErrorResponse, jsonNoStore } from '../../../lib/server/errors';
import { acceptReceiptUpload } from '../../../lib/server/services/receipts';

export const POST: RequestHandler = async ({ request }) => {
  try {
    const upload = await acceptReceiptUpload(request);
    if (upload.alreadyCaptured) {
      return jsonNoStore(
        { id: upload.id, status: upload.status, alreadyCaptured: true },
        { status: 200 },
      );
    }
    return jsonNoStore(
      { id: upload.id, status: upload.status },
      { status: 201 },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
};
