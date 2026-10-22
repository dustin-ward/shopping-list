/**
 * The fallback re-parse tier's engine seam (plan §6, R4).
 *
 * A helper is a second reading of the same evidence — it never invents evidence
 * and never touches `receipts.ocr_json`, which stays the immutable record of
 * what the OCR engine returned. The contract is deliberately narrow: the raw
 * OCR JSON (plus the same payload flattened to text, for text-in engines) goes
 * out, and a `receipt_lines`-shaped parse comes back. Two adapters share it:
 * the real engine over plain HTTP (`RECEIPT_HELPER_MODE=http`) and a committed
 * fixture that lets dev and tests exercise the flow without a model
 * (`RECEIPT_HELPER_MODE=stub`).
 *
 * Engine selection is deliberately deferred (ADR 0004): no candidate is shipped
 * yet, so `RECEIPT_HELPER_URL` unset means the whole tier is off. The seam is
 * what this ticket delivers, and it is what an evaluated engine plugs into.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { AppError } from '../errors';
import { receiptQuantityUnitSchema } from '../../shared/schemas';
import { HELPER_PARSE_VERSION } from '../../shared/receipt-helper';
import { receiptTotals } from '../../shared/receipt-totals';
import { describeFetchFailure } from './fetch-failure';
import type { ParsedReceipt, ParsedReceiptLine } from './parser';

/** What a helper is given: the receipt it belongs to and its raw OCR evidence. */
export type HelperRequest = {
  receiptId: string;
  /** `receipts.ocr_json`, exactly as the OCR engine returned it. */
  ocrJson: string;
  /** The same payload's line text, for engines that read text rather than JSON. */
  ocrText: string;
};

/**
 * One line in `receipt_lines` shape. `lineIndex` is the array position when the
 * service writes it; `sourceLineIndexes` is the parser's own bookkeeping and not
 * something a helper can know.
 */
export type HelperLine = Omit<ParsedReceiptLine, 'sourceLineIndexes'>;

export type HelperParse = {
  lines: HelperLine[];
  subtotalMinor: number | null;
  taxMinor: number | null;
  totalMinor: number | null;
  warnings: string[];
};

/** What a helper returns: a fresh parse over the stored evidence. */
export type HelperEngine = {
  reParse(request: HelperRequest): Promise<HelperParse>;
};

/**
 * The helper's response schema, enforced on everything a real engine sends
 * back. Money is integer minor units (a float is a rejection, not a rounding),
 * quantities are positive, and an unknown unit is refused rather than guessed —
 * the same rules the deterministic parser follows.
 */
const helperLineSchema = z
  .object({
    rawText: z.string().trim().min(1).max(500),
    parsedName: z.string().max(500).nullable(),
    quantityReal: z.number().positive().nullable(),
    quantityText: z.string().max(80).nullable(),
    quantityUnit: receiptQuantityUnitSchema.nullable(),
    unitPriceMinor: z.number().int().nullable(),
    totalPriceMinor: z.number().int().nullable(),
    isItemChunk: z.boolean(),
    confidence: z.number().min(0).max(1).nullable(),
  })
  .strict();

const helperParseSchema = z
  .object({
    lines: z.array(helperLineSchema).max(1000),
    subtotalMinor: z.number().int().nullable(),
    taxMinor: z.number().int().nullable(),
    totalMinor: z.number().int().nullable(),
    warnings: z.array(z.string().max(500)).max(100).default([]),
  })
  .strict();

/**
 * The fixture the stub adapter replays. It lives with the other receipt
 * fixtures, resolved from the repo root like the stub OCR payload, because
 * `pnpm dev`, the built e2e server and vitest all run from there. Production
 * ships neither this directory nor stub configuration.
 */
const STUB_HELPER_FIXTURE_PATH = resolve(
  process.cwd(),
  'tests/fixtures/receipts/stub-helper.json',
);

export type StubHelperEngineOptions = {
  fixturePath?: string;
};

/** Replay a committed helper response instead of calling a model. */
export function createStubHelperEngine(
  options: StubHelperEngineOptions = {},
): HelperEngine {
  const fixturePath = options.fixturePath ?? STUB_HELPER_FIXTURE_PATH;
  return {
    async reParse() {
      let raw: string;
      try {
        raw = readFileSync(fixturePath, 'utf8');
      } catch {
        throw new AppError(
          500,
          'HELPER_FIXTURE_MISSING',
          `The stub helper fixture is missing at ${fixturePath}.`,
        );
      }
      return parseHelperPayload(raw);
    },
  };
}

export type HttpHelperEngineOptions = {
  url: string;
  token?: string;
  timeoutMs: number;
  /** Test seam: the engine otherwise uses the process-wide `fetch`. */
  fetchImpl?: typeof fetch;
};

/**
 * POST the receipt's evidence to the helper and validate what comes back.
 * Failures are `AppError`s so the review route can say what happened; nothing is
 * written unless a complete, valid parse arrived.
 */
export function createHttpHelperEngine({
  url,
  token,
  timeoutMs,
  fetchImpl = fetch,
}: HttpHelperEngineOptions): HelperEngine {
  return {
    async reParse(request) {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new AppError(
          502,
          'HELPER_UNREACHABLE',
          `Could not reach the fallback helper at ${url}: ${describeFetchFailure(
            error,
          )}`,
        );
      }

      if (!response.ok) {
        throw new AppError(
          502,
          'HELPER_FAILED',
          `The fallback helper at ${url} responded with HTTP ${response.status}.`,
        );
      }

      return parseHelperPayload(await response.text());
    },
  };
}

export type HelperConfig = {
  receiptHelperUrl?: string;
  receiptHelperMode: 'http' | 'stub';
  receiptHelperTimeoutMs: number;
  receiptHelperToken?: string;
};

/**
 * Pick the helper for the runtime configuration. `RECEIPT_HELPER_URL` unset
 * means the tier is off: no affordance in review, no endpoint, and default
 * flows behave exactly as before (ADR 0004).
 */
export function helperEngineForConfig(
  config: HelperConfig,
): HelperEngine | undefined {
  if (!config.receiptHelperUrl) return undefined;
  if (config.receiptHelperMode === 'stub') return createStubHelperEngine();
  return createHttpHelperEngine({
    url: config.receiptHelperUrl,
    token: config.receiptHelperToken,
    timeoutMs: config.receiptHelperTimeoutMs,
  });
}

/**
 * The engine's output in the shape the parser's writer consumes. The parse
 * version is the helper's own, so the review screen can tell a helped parse
 * from a first one; the OCR line indexes stay empty because the helper read
 * text, not boxes, and the delta is recomputed with the shared arithmetic.
 */
export function toParsedReceipt(parse: HelperParse): ParsedReceipt {
  const lines: ParsedReceiptLine[] = parse.lines.map((line) => ({
    sourceLineIndexes: [],
    ...line,
  }));
  const { deltaMinor } = receiptTotals({
    lines,
    subtotalMinor: parse.subtotalMinor,
    taxMinor: parse.taxMinor,
    totalMinor: parse.totalMinor,
  });

  return {
    parseVersion: HELPER_PARSE_VERSION,
    lines,
    subtotalMinor: parse.subtotalMinor,
    taxMinor: parse.taxMinor,
    totalMinor: parse.totalMinor,
    deltaMinor,
    warnings: parse.warnings,
  };
}

/** Reject anything that is not the documented `receipt_lines`-shaped reply. */
function parseHelperPayload(raw: string): HelperParse {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new AppError(
      502,
      'HELPER_INVALID_RESPONSE',
      'The fallback helper returned a response that is not JSON.',
    );
  }

  const parsed = helperParseSchema.safeParse(payload);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.length ? ` at ${first.path.join('.')}` : '';
    throw new AppError(
      502,
      'HELPER_INVALID_RESPONSE',
      `The fallback helper returned an invalid parse${path}: ${
        first?.message ?? 'unexpected shape'
      }.`,
    );
  }

  return parsed.data;
}
