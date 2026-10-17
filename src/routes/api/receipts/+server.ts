import type { RequestHandler } from './$types';
import { apiErrorResponse, jsonNoStore } from '../../../lib/server/errors';
import {
  acceptReceiptUpload,
  listReceipts,
} from '../../../lib/server/services/receipts';

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

export const GET: RequestHandler = ({ url }) => {
  try {
    return jsonNoStore(
      listReceipts({
        status: url.searchParams.get('status'),
        hasUnknowns: url.searchParams.get('hasUnknowns'),
        cursor: url.searchParams.get('cursor'),
      }),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
};
