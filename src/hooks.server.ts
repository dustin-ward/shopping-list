import { building } from '$app/env';
import type { Handle } from '@sveltejs/kit/hooks';
import { AppError, apiErrorResponse } from './lib/server/errors';
import { getConfig } from './lib/server/config.js';

const unsafeMethods = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

// The receipt upload is multipart/form-data, so it is narrowly exempted from the
// JSON content-type gate; the origin (CSRF) check below still applies to it.
const receiptUploadPath = '/api/receipts';

export const handle: Handle = async ({ event, resolve }) => {
  // Prerendering creates the static shell without runtime deployment settings.
  if (building) return resolve(event);

  const config = getConfig();
  const expectedHost = new URL(config.canonicalOrigin).host.toLowerCase();
  const requestHost = event.request.headers.get('host')?.toLowerCase();
  if (requestHost !== expectedHost) {
    return new Response('Bad Request', {
      status: 400,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
      },
    });
  }

  if (
    event.url.pathname.startsWith('/api/') &&
    unsafeMethods.has(event.request.method)
  ) {
    const isReceiptUpload =
      event.request.method === 'POST' &&
      event.url.pathname === receiptUploadPath;
    if (!isReceiptUpload) {
      const contentType = event.request.headers
        .get('content-type')
        ?.split(';', 1)[0]
        .trim()
        .toLowerCase();
      if (contentType !== 'application/json') {
        return apiErrorResponse(
          new AppError(
            415,
            'UNSUPPORTED_MEDIA_TYPE',
            'Send this request as JSON.',
          ),
        );
      }
    }
    if (event.request.headers.get('origin') !== config.canonicalOrigin) {
      return apiErrorResponse(
        new AppError(
          403,
          'ORIGIN_REJECTED',
          'This request did not come from the configured app origin.',
        ),
      );
    }
  }

  return resolve(event);
};
