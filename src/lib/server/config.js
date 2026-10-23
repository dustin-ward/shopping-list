// @ts-check
import { z } from 'zod';

const assignedCurrencyCodes = new Set(Intl.supportedValuesOf('currency'));

/** @param {string} protocol */
const isHttpProtocol = (protocol) => ['http:', 'https:'].includes(protocol);

/**
 * Treat a blank receipt setting (an empty `.env` line or a blank compose
 * substitution) as unset, so the documented default applies. Other settings
 * keep failing loudly on a blank value.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string | undefined>}
 */
function withBlankReceiptValuesUnset(env) {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      key.startsWith('RECEIPT_') && value?.trim() === '' ? undefined : value,
    ]),
  );
}

const receiptCurrencySchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => assignedCurrencyCodes.has(value), {
    message: 'must be an assigned ISO 4217 currency code',
  })
  .default('USD');

/** An optional HTTP(S) endpoint, used by both engine settings. */
const optionalHttpUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => isHttpProtocol(new URL(value).protocol), {
    message: 'must be an HTTP(S) URL',
  })
  .optional();

/** An optional bearer token sent to either engine. */
const optionalBearerTokenSchema = z.string().trim().min(1).optional();

const runtimeConfigSchema = z.object({
  DATABASE_PATH: z.string().trim().min(1).default('/data/shopping-list.sqlite'),
  CANONICAL_ORIGIN: z.string().trim().url(),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  RECEIPT_CURRENCY: receiptCurrencySchema,
  RECEIPT_OCR_URL: optionalHttpUrlSchema,
  RECEIPT_OCR_MODE: z.enum(['http', 'stub']).default('http'),
  RECEIPT_OCR_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  RECEIPT_OCR_TOKEN: optionalBearerTokenSchema,
  /** Dev/test only: the fixture stub OCR replays instead of the committed one. */
  RECEIPT_OCR_STUB_FIXTURE: z.string().trim().min(1).optional(),
  RECEIPT_HELPER_URL: optionalHttpUrlSchema,
  RECEIPT_HELPER_MODE: z.enum(['http', 'stub']).default('http'),
  RECEIPT_HELPER_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  RECEIPT_HELPER_TOKEN: optionalBearerTokenSchema,
  RECEIPT_STORAGE_DIR: z.string().trim().min(1).default('/data/receipts'),
  RECEIPT_IMAGE_RETENTION: z
    .enum(['keep', 'until_commit', 'immediate'])
    .default('keep'),
});

/**
 * @typedef {object} AppConfig
 * @property {string} databasePath
 * @property {string} canonicalOrigin
 * @property {number} port
 * @property {'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'} logLevel
 * @property {string} receiptCurrency ISO 4217 code used for receipt money
 * @property {string | undefined} receiptOcrUrl OCR sidecar endpoint; unset disables capture
 * @property {'http' | 'stub'} receiptOcrMode
 * @property {number} receiptOcrTimeoutMs
 * @property {string | undefined} receiptOcrToken
 * @property {string | undefined} receiptOcrStubFixture dev/test stub payload path override
 * @property {string | undefined} receiptHelperUrl fallback re-parse endpoint; unset disables the tier
 * @property {'http' | 'stub'} receiptHelperMode
 * @property {number} receiptHelperTimeoutMs
 * @property {string | undefined} receiptHelperToken
 * @property {string} receiptStorageDir
 * @property {'keep' | 'until_commit' | 'immediate'} receiptImageRetention
 */

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {AppConfig}
 */
export function readConfig(env = process.env) {
  const parsed = runtimeConfigSchema.safeParse(
    withBlankReceiptValuesUnset(env),
  );
  if (!parsed.success) {
    const details = parsed.error.issues
      .map(
        (issue) =>
          `${issue.path.join('.') || 'configuration'}: ${issue.message}`,
      )
      .join('; ');
    throw new Error(`Invalid runtime configuration: ${details}`);
  }

  const canonicalUrl = new URL(parsed.data.CANONICAL_ORIGIN);
  if (
    !isHttpProtocol(canonicalUrl.protocol) ||
    canonicalUrl.username !== '' ||
    canonicalUrl.password !== '' ||
    canonicalUrl.pathname !== '/' ||
    canonicalUrl.search !== '' ||
    canonicalUrl.hash !== ''
  ) {
    throw new Error(
      'Invalid runtime configuration: CANONICAL_ORIGIN must be an HTTP(S) origin without a path or credentials',
    );
  }

  return {
    databasePath: parsed.data.DATABASE_PATH,
    canonicalOrigin: canonicalUrl.origin,
    port: parsed.data.PORT,
    logLevel: parsed.data.LOG_LEVEL,
    receiptCurrency: parsed.data.RECEIPT_CURRENCY,
    receiptOcrUrl: parsed.data.RECEIPT_OCR_URL,
    receiptOcrMode: parsed.data.RECEIPT_OCR_MODE,
    receiptOcrTimeoutMs: parsed.data.RECEIPT_OCR_TIMEOUT_MS,
    receiptOcrToken: parsed.data.RECEIPT_OCR_TOKEN,
    receiptOcrStubFixture: parsed.data.RECEIPT_OCR_STUB_FIXTURE,
    receiptHelperUrl: parsed.data.RECEIPT_HELPER_URL,
    receiptHelperMode: parsed.data.RECEIPT_HELPER_MODE,
    receiptHelperTimeoutMs: parsed.data.RECEIPT_HELPER_TIMEOUT_MS,
    receiptHelperToken: parsed.data.RECEIPT_HELPER_TOKEN,
    receiptStorageDir: parsed.data.RECEIPT_STORAGE_DIR,
    receiptImageRetention: parsed.data.RECEIPT_IMAGE_RETENTION,
  };
}

/** @returns {AppConfig} */
export function getConfig() {
  return readConfig(process.env);
}
