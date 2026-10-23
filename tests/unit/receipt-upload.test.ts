import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/lib/client/api';
import { ReceiptImageError } from '../../src/lib/client/receipt-image';
import {
  parseUploadResponse,
  receiptUploadErrorMessage,
  uploadReceipt,
  type UploadRequest,
} from '../../src/lib/client/receipt-upload';

const RECEIPT_ID = '8f14e45f-ea0b-4a3c-9c1e-4e2f9a3b7c11';
const SERVER_INSTANCE_ID = '1c05d4e0-90ba-4bc1-b50f-2edb2a5a8725';

type Listener = () => void;

class FakeUploadRequest implements UploadRequest {
  method = '';
  url = '';
  status = 0;
  responseText = '';
  headers = new Map<string, string>();
  sent: FormData | null = null;
  private listeners = new Map<string, Listener>();
  private progressListener: ((event: ProgressEvent) => void) | null = null;

  readonly upload = {
    addEventListener: (
      _type: string,
      listener: (event: ProgressEvent) => void,
    ) => {
      this.progressListener = listener;
    },
  };

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, listener);
  }

  send(body: FormData): void {
    this.sent = body;
  }

  emit(type: string): void {
    this.listeners.get(type)?.();
  }

  emitProgress(loaded: number, total: number, lengthComputable = true): void {
    this.progressListener?.({
      loaded,
      total,
      lengthComputable,
    } as ProgressEvent);
  }
}

describe('parseUploadResponse', () => {
  it('reads a new capture from the 201 response', () => {
    expect(
      parseUploadResponse(
        201,
        JSON.stringify({ id: RECEIPT_ID, status: 'pending' }),
      ),
    ).toEqual({ id: RECEIPT_ID, status: 'pending', alreadyCaptured: false });
  });

  it('marks a deduplicated upload as already captured', () => {
    expect(
      parseUploadResponse(
        200,
        JSON.stringify({
          id: RECEIPT_ID,
          status: 'review',
          alreadyCaptured: true,
        }),
      ),
    ).toEqual({ id: RECEIPT_ID, status: 'review', alreadyCaptured: true });
  });

  it('throws the server failure for a rejection', () => {
    const error = catchError(() =>
      parseUploadResponse(
        413,
        JSON.stringify({
          error: {
            code: 'IMAGE_TOO_LARGE',
            message: 'Receipt images must be 10 MB or smaller.',
          },
        }),
      ),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 413,
      code: 'IMAGE_TOO_LARGE',
      message: 'Receipt images must be 10 MB or smaller.',
    });
  });

  it('throws a generic failure when the body is not a receipt response', () => {
    expect(
      catchError(() => parseUploadResponse(502, '<html>bad gateway</html>')),
    ).toMatchObject({ status: 502, code: 'REQUEST_FAILED' });
    expect(
      catchError(() =>
        parseUploadResponse(201, JSON.stringify({ id: 'nope' })),
      ),
    ).toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

describe('receiptUploadErrorMessage', () => {
  it('explains an offline failure in reader terms', () => {
    const message = receiptUploadErrorMessage(
      new ApiError(0, 'NETWORK_ERROR', 'unreachable'),
    );

    expect(message).toMatch(/offline/i);
    expect(message).toMatch(/try again/i);
  });

  it('explains a too-large rejection', () => {
    expect(
      receiptUploadErrorMessage(
        new ApiError(413, 'IMAGE_TOO_LARGE', 'Receipt images must be 10 MB…'),
      ),
    ).toMatch(/too large/i);
    expect(
      receiptUploadErrorMessage(
        new ApiError(
          413,
          'REQUEST_TOO_LARGE',
          'The upload request is too large.',
        ),
      ),
    ).toMatch(/too large/i);
  });

  it('explains an unsupported file type', () => {
    expect(
      receiptUploadErrorMessage(
        new ApiError(415, 'UNSUPPORTED_IMAGE', 'Upload a JPEG, PNG, or WebP…'),
      ),
    ).toMatch(/JPEG, PNG, or WebP/);
  });

  it('passes a local image failure through unchanged', () => {
    const error = new ReceiptImageError(
      'too-large',
      'That photo is too large to upload.',
    );

    expect(receiptUploadErrorMessage(error)).toBe(
      'That photo is too large to upload.',
    );
  });

  it('falls back to the server message, then to a generic one', () => {
    expect(
      receiptUploadErrorMessage(
        new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong.'),
      ),
    ).toBe('Something went wrong.');
    expect(receiptUploadErrorMessage(new Error('boom'))).toMatch(
      /could not be captured/i,
    );
  });
});

describe('uploadReceipt', () => {
  const file = new Blob(['compressed-bytes'], { type: 'image/webp' });

  it('posts the prepared image as multipart to the upload endpoint', async () => {
    const request = new FakeUploadRequest();

    const pending = uploadReceipt(file, {
      serverInstanceId: SERVER_INSTANCE_ID,
      createRequest: () => request,
    });

    expect(request.method).toBe('POST');
    expect(request.url).toBe('/api/receipts');
    expect(request.headers.get('x-server-instance-id')).toBe(
      SERVER_INSTANCE_ID,
    );
    const sent = request.sent;
    expect(sent?.get('image')).toBeInstanceOf(File);
    expect((sent?.get('image') as File).name).toBe('receipt.webp');

    request.status = 201;
    request.responseText = JSON.stringify({
      id: RECEIPT_ID,
      status: 'pending',
    });
    request.emit('load');

    await expect(pending).resolves.toEqual({
      id: RECEIPT_ID,
      status: 'pending',
      alreadyCaptured: false,
    });
  });

  it('reports upload progress as a fraction of the bytes sent', async () => {
    const request = new FakeUploadRequest();
    const onProgress = vi.fn();

    uploadReceipt(file, {
      serverInstanceId: SERVER_INSTANCE_ID,
      createRequest: () => request,
      onProgress,
    });
    request.emitProgress(30, 100);
    request.emitProgress(50, 100);
    request.emitProgress(80, 100, false);

    expect(onProgress.mock.calls).toEqual([[0.3], [0.5]]);
    request.status = 201;
    request.responseText = JSON.stringify({
      id: RECEIPT_ID,
      status: 'pending',
    });
    request.emit('load');
  });

  it('rejects with an offline error when the request never reaches the server', async () => {
    const request = new FakeUploadRequest();

    const pending = uploadReceipt(file, {
      serverInstanceId: SERVER_INSTANCE_ID,
      createRequest: () => request,
    });
    request.emit('error');

    await expect(pending).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
});

function catchError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to throw.');
}
