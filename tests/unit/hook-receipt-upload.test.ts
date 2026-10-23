import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import { handle } from '../../src/hooks.server';

const origin = process.env.CANONICAL_ORIGIN ?? 'http://localhost:5173';
const host = new URL(origin).host;

function eventOf(request: Request): RequestEvent {
  return { request, url: new URL(request.url) } as unknown as RequestEvent;
}

function headers(extra: Record<string, string>): Headers {
  // A constructed Request carries no Host header; real requests always do.
  return new Headers({ host, ...extra });
}

function run(request: Request) {
  return handle({
    event: eventOf(request),
    resolve: vi.fn(async () => new Response('ok')),
  });
}

describe('receipt upload content-type exemption', () => {
  it('lets a same-origin multipart upload through the JSON gate', async () => {
    const request = new Request(`${origin}/api/receipts`, {
      method: 'POST',
      headers: headers({
        origin,
        'content-type': 'multipart/form-data; boundary=test-boundary',
      }),
    });

    const response = await run(request);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  it('still rejects a cross-origin upload', async () => {
    const request = new Request(`${origin}/api/receipts`, {
      method: 'POST',
      headers: headers({
        origin: 'https://untrusted.example',
        'content-type': 'multipart/form-data; boundary=test-boundary',
      }),
    });

    const response = await run(request);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: 'ORIGIN_REJECTED' },
    });
  });

  it('keeps the JSON gate for every other API route', async () => {
    const request = new Request(`${origin}/api/entries`, {
      method: 'POST',
      headers: headers({
        origin,
        'content-type': 'multipart/form-data; boundary=test-boundary',
      }),
    });

    const response = await run(request);

    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({
      error: { code: 'UNSUPPORTED_MEDIA_TYPE' },
    });
  });

  it('keeps the JSON gate for other methods on the upload path', async () => {
    const request = new Request(`${origin}/api/receipts`, {
      method: 'PATCH',
      headers: headers({
        origin,
        'content-type': 'multipart/form-data; boundary=test-boundary',
      }),
    });

    const response = await run(request);

    expect(response.status).toBe(415);
  });
});
