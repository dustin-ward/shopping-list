import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/lib/server/errors';
import {
  createHttpHelperEngine,
  createStubHelperEngine,
  toParsedReceipt,
  type HelperParse,
} from '../../src/lib/server/receipts/helper-engine';
import { HELPER_PARSE_VERSION } from '../../src/lib/shared/receipt-helper';

/**
 * The fallback helper's seam: one HTTP contract, validated strictly, plus a
 * fixture adapter for dev/test. What the engine returns must already be
 * `receipt_lines`-shaped, and a malformed reply must never reach the database.
 */

const fixturePath = resolve(
  process.cwd(),
  'tests/fixtures/receipts/stub-helper.json',
);
const fixture = readFileSync(fixturePath, 'utf8');

const input = {
  receiptId: '00000000-0000-4000-8000-0000000000aa',
  ocrJson: '{"pages":[{"lines":[{"text":"MILK 2% 1L"}]}]}',
  ocrText: 'MILK 2% 1L',
};

function validParse(overrides: Partial<HelperParse> = {}): HelperParse {
  return {
    lines: [
      {
        rawText: 'MILK 2% 1L',
        parsedName: 'MILK 2% 1L',
        quantityReal: null,
        quantityText: null,
        quantityUnit: null,
        unitPriceMinor: null,
        totalPriceMinor: 295,
        isItemChunk: true,
        confidence: 0.92,
      },
    ],
    subtotalMinor: 295,
    taxMinor: null,
    totalMinor: 295,
    warnings: [],
    ...overrides,
  };
}

/** A fetch that records the request and replies with one body. */
function fakeFetch(response: Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('helper engine — HTTP adapter', () => {
  it('posts the receipt id and the untouched OCR evidence', async () => {
    const { calls, fetchImpl } = fakeFetch(
      Response.json(validParse(), { status: 200 }),
    );
    const engine = createHttpHelperEngine({
      url: 'http://helper.invalid/parse',
      token: 'shared-secret',
      timeoutMs: 5000,
      fetchImpl,
    });

    const parse = await engine.reParse(input);

    expect(parse.lines).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://helper.invalid/parse');
    const body = JSON.parse(String(calls[0]?.init?.body)) as unknown;
    expect(body).toEqual({
      receiptId: input.receiptId,
      ocrJson: input.ocrJson,
      ocrText: input.ocrText,
    });
    expect(
      (calls[0]?.init?.headers as Record<string, string>).authorization,
    ).toBe('Bearer shared-secret');
  });

  it('names an unreachable helper instead of storing a partial result', async () => {
    const engine = createHttpHelperEngine({
      url: 'http://helper.invalid/parse',
      timeoutMs: 5000,
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });

    await expect(engine.reParse(input)).rejects.toMatchObject({
      code: 'HELPER_UNREACHABLE',
      status: 502,
    });
  });

  it('rejects a non-200 reply', async () => {
    const engine = createHttpHelperEngine({
      url: 'http://helper.invalid/parse',
      timeoutMs: 5000,
      fetchImpl: fakeFetch(new Response('nope', { status: 503 })).fetchImpl,
    });

    await expect(engine.reParse(input)).rejects.toMatchObject({
      code: 'HELPER_FAILED',
    });
  });

  it('rejects a reply that is not JSON', async () => {
    const engine = createHttpHelperEngine({
      url: 'http://helper.invalid/parse',
      timeoutMs: 5000,
      fetchImpl: fakeFetch(new Response('<html>oops</html>')).fetchImpl,
    });

    const attempt = engine.reParse(input);
    await expect(attempt).rejects.toBeInstanceOf(AppError);
    await expect(attempt).rejects.toMatchObject({
      code: 'HELPER_INVALID_RESPONSE',
    });
  });

  it('rejects a JSON reply that is not receipt_lines-shaped', async () => {
    const engine = createHttpHelperEngine({
      url: 'http://helper.invalid/parse',
      timeoutMs: 5000,
      fetchImpl: fakeFetch(
        Response.json({ lines: [{ rawText: 'MILK', totalPriceMinor: 12.5 }] }),
      ).fetchImpl,
    });

    await expect(engine.reParse(input)).rejects.toMatchObject({
      code: 'HELPER_INVALID_RESPONSE',
    });
  });
});

describe('helper engine — fixture adapter', () => {
  it('replays the committed fixture through the same validation', async () => {
    const engine = createStubHelperEngine({ fixturePath });

    const parse = await engine.reParse(input);

    expect(parse).toEqual(JSON.parse(fixture));
  });

  it('fails loudly when the fixture is missing', async () => {
    const engine = createStubHelperEngine({
      fixturePath: resolve(
        process.cwd(),
        'tests/fixtures/receipts/missing.json',
      ),
    });

    await expect(engine.reParse(input)).rejects.toMatchObject({
      code: 'HELPER_FIXTURE_MISSING',
    });
  });
});

describe('toParsedReceipt', () => {
  it('stamps helper output with the helper parse version and totals delta', () => {
    const parsed = toParsedReceipt(validParse());

    expect(parsed.parseVersion).toBe(HELPER_PARSE_VERSION);
    expect(parsed.lines[0]).toMatchObject({
      rawText: 'MILK 2% 1L',
      isItemChunk: true,
      totalPriceMinor: 295,
      // The helper never reports OCR line indexes: it reads the text, not boxes.
      sourceLineIndexes: [],
    });
    expect(parsed.subtotalMinor).toBe(295);
    expect(parsed.totalMinor).toBe(295);
    expect(parsed.deltaMinor).toBe(0);
  });
});
