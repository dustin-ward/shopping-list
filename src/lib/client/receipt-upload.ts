/**
 * Upload one already-compressed capture to `POST /api/receipts`.
 *
 * XMLHttpRequest (not fetch) because upload progress is part of the capture
 * moment: a phone photo over a tailnet link can take a while, and the user
 * needs to see it moving. The wrapper is injectable so the request/response
 * handling is testable without a browser.
 */

import { ApiError } from './api';
import { ReceiptImageError, TOO_LARGE_MESSAGE } from './receipt-image';
import {
  receiptUploadResponseSchema,
  type ReceiptStatus,
} from '../shared/schemas';

export type ReceiptUploadResult = {
  id: string;
  status: ReceiptStatus;
  /** True when these exact bytes were already on the server (sha256 dedupe). */
  alreadyCaptured: boolean;
};

export type UploadReceiptOptions = {
  /** Fraction of the upload body already sent, 0–1. */
  onProgress?: (fraction: number) => void;
  /** Test seam; defaults to a real XMLHttpRequest. */
  createRequest?: () => UploadRequest;
};

/** The subset of XMLHttpRequest the upload uses. */
export interface UploadRequest {
  open(method: string, url: string): void;
  addEventListener(
    type: 'load' | 'error' | 'abort',
    listener: () => void,
  ): void;
  upload: {
    addEventListener(
      type: 'progress',
      listener: (event: ProgressEvent) => void,
    ): void;
  };
  send(body: FormData): void;
  status: number;
  responseText: string;
}

export function uploadReceipt(
  file: Blob,
  options: UploadReceiptOptions = {},
): Promise<ReceiptUploadResult> {
  const createRequest = options.createRequest ?? defaultUploadRequest;

  return new Promise<ReceiptUploadResult>((resolve, reject) => {
    const form = new FormData();
    form.append('image', file, receiptImageFilename(file.type));

    const request = createRequest();
    request.open('POST', '/api/receipts');

    request.upload.addEventListener('progress', (event) => {
      if (!options.onProgress || !event.lengthComputable || event.total <= 0)
        return;
      options.onProgress(Math.min(1, event.loaded / event.total));
    });

    request.addEventListener('load', () => {
      try {
        resolve(parseUploadResponse(request.status, request.responseText));
      } catch (error) {
        reject(error);
      }
    });
    request.addEventListener('error', () =>
      reject(
        new ApiError(0, 'NETWORK_ERROR', 'The image never reached the server.'),
      ),
    );
    request.addEventListener('abort', () =>
      reject(new ApiError(0, 'UPLOAD_ABORTED', 'The upload was cancelled.')),
    );

    request.send(form);
  });
}

/** The original filename is discarded server-side; this is just for logs. */
function receiptImageFilename(type: string): string {
  if (type === 'image/webp') return 'receipt.webp';
  if (type === 'image/png') return 'receipt.png';
  return 'receipt.jpg';
}

/**
 * Turn the upload response into a result, or into the same `ApiError` the rest
 * of the client uses so callers have one failure shape to handle.
 */
export function parseUploadResponse(
  status: number,
  body: string,
): ReceiptUploadResult {
  const parsed = parseBody(body);
  if (status === 200 || status === 201) {
    const result = receiptUploadResponseSchema.safeParse(parsed);
    if (!result.success) {
      throw new ApiError(
        status,
        'INVALID_RESPONSE',
        'The server returned an unexpected response.',
      );
    }
    return {
      id: result.data.id,
      status: result.data.status,
      alreadyCaptured: result.data.alreadyCaptured ?? false,
    };
  }

  const failure = (parsed ?? {}) as {
    error?: { code?: string; message?: string };
  };
  throw new ApiError(
    status,
    failure.error?.code ?? 'REQUEST_FAILED',
    failure.error?.message ?? 'The receipt could not be uploaded.',
  );
}

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/** One reader-facing sentence for every capture failure the client can hit. */
export function receiptUploadErrorMessage(error: unknown): string {
  if (error instanceof ReceiptImageError) return error.message;
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'NETWORK_ERROR':
        return 'You look offline. Reconnect and try again.';
      case 'UPLOAD_ABORTED':
        return 'The upload was cancelled. Try again.';
      case 'IMAGE_TOO_LARGE':
      case 'REQUEST_TOO_LARGE':
        return TOO_LARGE_MESSAGE;
      case 'UNSUPPORTED_IMAGE':
        return "That file isn't a photo the scanner can read. Use a JPEG, PNG, or WebP image.";
      default:
        return error.message;
    }
  }
  return 'The receipt could not be captured. Please try again.';
}

function defaultUploadRequest(): UploadRequest {
  return new XMLHttpRequest() as unknown as UploadRequest;
}
