import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { AppError } from '../errors';
import { describeFetchFailure } from './fetch-failure';

/**
 * The OCR seam the worker drives. Two adapters share it: the real sidecar over
 * plain HTTP (`RECEIPT_OCR_MODE=http`) and a committed fixture that lets the
 * whole queue run in dev and tests without Python (`RECEIPT_OCR_MODE=stub`).
 * The engine is stateless and returns raw output, which the worker stores
 * verbatim — the raw engine payload is immutable evidence, per capture-first.
 */

/** Stored image filename (not an absolute path), as written by the upload route. */
export type OcrRequest = {
  imagePath: string;
  imageBytes: Uint8Array;
};

export type OcrResult = {
  /** Raw engine output, stored verbatim in `receipts.ocr_json`. */
  raw: string;
};

export type OcrEngine = {
  extract(request: OcrRequest): Promise<OcrResult>;
};

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/** Content type for the stored image, derived from the extension the upload route assigned. */
export function imageContentType(imagePath: string): string {
  return (
    IMAGE_CONTENT_TYPES[extname(imagePath).toLowerCase()] ??
    'application/octet-stream'
  );
}

/**
 * The fixture the stub engine replays. It lives with the other committed receipt
 * fixtures under `tests/fixtures/receipts/` and is resolved from the repo root,
 * which is the one location every stub-mode consumer shares (`pnpm dev`, the
 * built server the e2e suite starts, and vitest). Stub mode is a dev/test-only
 * mode: production runs `RECEIPT_OCR_MODE=http`, and the runtime image ships
 * neither this directory nor stub configuration.
 */
export const STUB_OCR_FIXTURE_PATH = resolve(
  process.cwd(),
  'tests/fixtures/receipts/stub-ocr.json',
);

export type StubOcrEngineOptions = {
  fixturePath?: string;
};

/** Replay a committed OCR payload instead of calling a sidecar. */
export function createStubOcrEngine(
  options: StubOcrEngineOptions = {},
): OcrEngine {
  const fixturePath = options.fixturePath ?? STUB_OCR_FIXTURE_PATH;
  return {
    async extract() {
      let raw: string;
      try {
        raw = readFileSync(fixturePath, 'utf8');
      } catch {
        throw new AppError(
          500,
          'OCR_FIXTURE_MISSING',
          `The stub OCR fixture is missing at ${fixturePath}.`,
        );
      }
      return { raw: parseOcrPayload(raw) };
    },
  };
}

export type HttpOcrEngineOptions = {
  url: string;
  token?: string;
  timeoutMs: number;
  /** Test seam: the engine otherwise uses the process-wide `fetch`. */
  fetchImpl?: typeof fetch;
};

/**
 * POST the image bytes to the sidecar's `POST /ocr` and return its body
 * verbatim. Failures surface as `AppError`s so the worker can store a readable
 * `last_error`; the sidecar never touches SQLite, so a down engine degrades to
 * pending + bounded retries rather than an outage.
 */
export function createHttpOcrEngine({
  url,
  token,
  timeoutMs,
  fetchImpl = fetch,
}: HttpOcrEngineOptions): OcrEngine {
  return {
    async extract({ imagePath, imageBytes }) {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': imageContentType(imagePath),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: toFetchBody(imageBytes),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new AppError(
          502,
          'OCR_UNREACHABLE',
          `Could not reach the OCR engine at ${url}: ${describeFetchFailure(error)}`,
        );
      }

      if (!response.ok) {
        throw new AppError(
          502,
          'OCR_FAILED',
          `The OCR engine at ${url} responded with HTTP ${response.status}.`,
        );
      }

      return { raw: parseOcrPayload(await response.text()) };
    },
  };
}

/**
 * Reject a payload that is not the documented sidecar shape, so a proxy error
 * page can never be stored as if it were OCR output.
 */
function parseOcrPayload(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError(
      502,
      'OCR_INVALID_RESPONSE',
      'The OCR engine returned a response that is not JSON.',
    );
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { pages?: unknown }).pages)
  ) {
    throw new AppError(
      502,
      'OCR_INVALID_RESPONSE',
      'The OCR engine response has no pages.',
    );
  }

  return raw;
}

/**
 * `fetch` accepts only an `ArrayBuffer`-backed view as a body, while the bytes
 * the worker reads from disk are a `Buffer` (a `Uint8Array` over a pooled
 * `ArrayBufferLike`). Copying into a fresh view is the one place that matters.
 */
function toFetchBody(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}
