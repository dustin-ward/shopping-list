import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHttpOcrEngine,
  createStubOcrEngine,
  imageContentType,
  STUB_OCR_FIXTURE_PATH,
} from '../../src/lib/server/receipts/ocr-engine';

const OCR_URL = 'http://receipt-ocr:8060/ocr';

type FetchCall = [RequestInfo | URL, RequestInit | undefined];

function fetchSpy(handler: (url: string, init: RequestInit) => Response) {
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push([url, init]);
    return handler(String(url), init ?? {});
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const imageBytes = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x42]);

describe('OCR image content type', () => {
  it('maps the extensions the upload route assigns', () => {
    expect(imageContentType('abc.jpg')).toBe('image/jpeg');
    expect(imageContentType('abc.png')).toBe('image/png');
    expect(imageContentType('abc.webp')).toBe('image/webp');
    expect(imageContentType('abc.JPG')).toBe('image/jpeg');
    expect(imageContentType('abc.tiff')).toBe('application/octet-stream');
  });
});

describe('HTTP OCR engine', () => {
  it('posts the image bytes to the configured URL and returns the body verbatim', async () => {
    const body = '{"pages":[{"lines":[]}],"engine":{"name":"indra-ocr"}}';
    const { impl, calls } = fetchSpy(() => new Response(body, { status: 200 }));

    const result = await createHttpOcrEngine({
      url: OCR_URL,
      timeoutMs: 30_000,
      fetchImpl: impl,
    }).extract({ imagePath: 'abc.png', imageBytes: imageBytes() });

    expect(result.raw).toBe(body);
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0];
    expect(String(url)).toBe(OCR_URL);
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('content-type')).toBe('image/png');
    expect(init?.body).toEqual(imageBytes());
  });

  it('sends the bearer token only when one is configured', async () => {
    const { impl: withToken, calls: tokenCalls } = fetchSpy(
      () => new Response('{"pages":[]}', { status: 200 }),
    );
    const { impl: withoutToken, calls: plainCalls } = fetchSpy(
      () => new Response('{"pages":[]}', { status: 200 }),
    );

    await createHttpOcrEngine({
      url: OCR_URL,
      token: 'shared-secret',
      timeoutMs: 1000,
      fetchImpl: withToken,
    }).extract({ imagePath: 'abc.jpg', imageBytes: imageBytes() });
    await createHttpOcrEngine({
      url: OCR_URL,
      timeoutMs: 1000,
      fetchImpl: withoutToken,
    }).extract({ imagePath: 'abc.jpg', imageBytes: imageBytes() });

    expect(new Headers(tokenCalls[0][1]?.headers).get('authorization')).toBe(
      'Bearer shared-secret',
    );
    expect(
      new Headers(plainCalls[0][1]?.headers).get('authorization'),
    ).toBeNull();
  });

  it('reports a non-OK response as an OCR failure', async () => {
    const { impl } = fetchSpy(() => new Response('boom', { status: 503 }));

    await expect(
      createHttpOcrEngine({
        url: OCR_URL,
        timeoutMs: 1000,
        fetchImpl: impl,
      }).extract({ imagePath: 'abc.jpg', imageBytes: imageBytes() }),
    ).rejects.toMatchObject({
      code: 'OCR_FAILED',
      message: expect.stringContaining('503') as unknown as string,
    });
  });

  it('refuses a response that is not JSON or has no pages', async () => {
    const notJson = fetchSpy(() => new Response('<html>oops</html>'));
    const noPages = fetchSpy(() => new Response('{"engine":{}}'));

    await expect(
      createHttpOcrEngine({
        url: OCR_URL,
        timeoutMs: 1000,
        fetchImpl: notJson.impl,
      }).extract({ imagePath: 'abc.jpg', imageBytes: imageBytes() }),
    ).rejects.toMatchObject({ code: 'OCR_INVALID_RESPONSE' });

    await expect(
      createHttpOcrEngine({
        url: OCR_URL,
        timeoutMs: 1000,
        fetchImpl: noPages.impl,
      }).extract({ imagePath: 'abc.jpg', imageBytes: imageBytes() }),
    ).rejects.toMatchObject({ code: 'OCR_INVALID_RESPONSE' });
  });

  it('surfaces a connection failure with its cause', async () => {
    const impl = vi.fn(async () => {
      throw new Error('fetch failed', {
        cause: new Error('connect ECONNREFUSED 127.0.0.1:1'),
      });
    }) as unknown as typeof fetch;

    await expect(
      createHttpOcrEngine({
        url: OCR_URL,
        timeoutMs: 1000,
        fetchImpl: impl,
      }).extract({ imagePath: 'abc.jpg', imageBytes: imageBytes() }),
    ).rejects.toMatchObject({
      code: 'OCR_UNREACHABLE',
      message: expect.stringContaining('ECONNREFUSED') as unknown as string,
    });
  });

  it('reports a timed-out request as unreachable', async () => {
    const impl = vi.fn(async () => {
      throw new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      );
    }) as unknown as typeof fetch;

    await expect(
      createHttpOcrEngine({
        url: OCR_URL,
        timeoutMs: 50,
        fetchImpl: impl,
      }).extract({ imagePath: 'abc.jpg', imageBytes: imageBytes() }),
    ).rejects.toMatchObject({
      code: 'OCR_UNREACHABLE',
      message: expect.stringContaining('timed out') as unknown as string,
    });
  });
});

describe('stub OCR engine', () => {
  it('replays the committed fixture byte-for-byte', async () => {
    const result = await createStubOcrEngine().extract({
      imagePath: 'abc.jpg',
      imageBytes: imageBytes(),
    });

    expect(JSON.parse(result.raw)).toMatchObject({
      pages: [expect.objectContaining({ lines: expect.any(Array) })],
    });
    expect(
      STUB_OCR_FIXTURE_PATH.endsWith('tests/fixtures/receipts/stub-ocr.json'),
    ).toBe(true);
  });

  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'shopping-list-stub-ocr-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('names the missing fixture when it cannot be read', async () => {
    const fixturePath = join(directory, 'absent.json');

    await expect(
      createStubOcrEngine({ fixturePath }).extract({
        imagePath: 'abc.jpg',
        imageBytes: imageBytes(),
      }),
    ).rejects.toMatchObject({
      code: 'OCR_FIXTURE_MISSING',
      message: expect.stringContaining(fixturePath) as unknown as string,
    });
  });

  it('rejects a fixture that is not an OCR payload', async () => {
    const fixturePath = join(directory, 'broken.json');
    writeFileSync(fixturePath, 'not json');

    await expect(
      createStubOcrEngine({ fixturePath }).extract({
        imagePath: 'abc.jpg',
        imageBytes: imageBytes(),
      }),
    ).rejects.toMatchObject({ code: 'OCR_INVALID_RESPONSE' });
  });
});
