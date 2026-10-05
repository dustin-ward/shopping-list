import type { RequestHandler } from './$types';
import { apiErrorResponse, jsonNoStore } from '../../../lib/server/errors';
import { getSnapshot } from '../../../lib/server/services/snapshot';

export const GET: RequestHandler = ({ request }) => {
  try {
    const snapshot = getSnapshot();
    const etag = `"${snapshot.serverInstanceId}:${snapshot.revision}"`;
    const candidates = request.headers
      .get('if-none-match')
      ?.split(',')
      .map((value) => value.trim());
    if (
      candidates?.some((candidate) => candidate === etag || candidate === '*')
    ) {
      return new Response(null, {
        status: 304,
        headers: { etag, 'cache-control': 'no-store' },
      });
    }
    return jsonNoStore(snapshot, { headers: { etag } });
  } catch (error) {
    return apiErrorResponse(error);
  }
};
