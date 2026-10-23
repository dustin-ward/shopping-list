import type { RequestHandler } from './$types';
import { apiErrorResponse } from '../../../../../lib/server/errors';
import { getReceiptImage } from '../../../../../lib/server/services/receipts';

// Same-origin blob stream with `no-store`, matching the rest of the API's
// cache rules; the client <img> is the only intended consumer.
export const GET: RequestHandler = ({ params }) => {
  try {
    const { bytes, contentType } = getReceiptImage(params.id);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': contentType,
        'content-length': String(bytes.byteLength),
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
};
