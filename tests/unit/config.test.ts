import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/lib/server/config.js';

describe('runtime configuration', () => {
  it('applies safe defaults and canonicalizes the configured origin', () => {
    expect(
      readConfig({ CANONICAL_ORIGIN: 'https://shopping-list.example.ts.net/' }),
    ).toEqual({
      databasePath: '/data/shopping-list.sqlite',
      canonicalOrigin: 'https://shopping-list.example.ts.net',
      port: 3000,
      logLevel: 'info',
      receiptCurrency: 'USD',
      receiptOcrUrl: undefined,
      receiptOcrMode: 'http',
      receiptOcrTimeoutMs: 30_000,
      receiptOcrToken: undefined,
      receiptStorageDir: '/data/receipts',
      receiptImageRetention: 'keep',
    });
  });

  it('reads receipt-scanner overrides', () => {
    expect(
      readConfig({
        CANONICAL_ORIGIN: 'https://shopping-list.example.ts.net',
        RECEIPT_CURRENCY: 'eur',
        RECEIPT_OCR_URL: 'http://receipt-ocr:8060/ocr',
        RECEIPT_OCR_MODE: 'stub',
        RECEIPT_OCR_TIMEOUT_MS: '5000',
        RECEIPT_OCR_TOKEN: 'shared-secret',
        RECEIPT_STORAGE_DIR: '/tmp/receipts',
        RECEIPT_IMAGE_RETENTION: 'until_commit',
      }),
    ).toMatchObject({
      receiptCurrency: 'EUR',
      receiptOcrUrl: 'http://receipt-ocr:8060/ocr',
      receiptOcrMode: 'stub',
      receiptOcrTimeoutMs: 5000,
      receiptOcrToken: 'shared-secret',
      receiptStorageDir: '/tmp/receipts',
      receiptImageRetention: 'until_commit',
    });
  });

  it('treats blank receipt-scanner values as unset defaults', () => {
    expect(
      readConfig({
        CANONICAL_ORIGIN: 'https://shopping-list.example.ts.net',
        RECEIPT_CURRENCY: '',
        RECEIPT_OCR_URL: '   ',
        RECEIPT_OCR_MODE: '',
        RECEIPT_OCR_TIMEOUT_MS: '',
        RECEIPT_OCR_TOKEN: '',
        RECEIPT_STORAGE_DIR: ' ',
        RECEIPT_IMAGE_RETENTION: '',
      }),
    ).toMatchObject({
      receiptCurrency: 'USD',
      receiptOcrUrl: undefined,
      receiptOcrMode: 'http',
      receiptOcrTimeoutMs: 30_000,
      receiptOcrToken: undefined,
      receiptStorageDir: '/data/receipts',
      receiptImageRetention: 'keep',
    });
  });

  it('rejects a currency that is not an assigned ISO 4217 code', () => {
    expect(() =>
      readConfig({
        CANONICAL_ORIGIN: 'https://shopping-list.example.ts.net',
        RECEIPT_CURRENCY: 'XYZ',
      }),
    ).toThrow(/RECEIPT_CURRENCY/);
  });

  it('rejects a non-URL OCR endpoint', () => {
    expect(() =>
      readConfig({
        CANONICAL_ORIGIN: 'https://shopping-list.example.ts.net',
        RECEIPT_OCR_URL: 'receipt-ocr:8060',
      }),
    ).toThrow(/RECEIPT_OCR_URL/);
  });

  it('rejects an unknown OCR mode', () => {
    expect(() =>
      readConfig({
        CANONICAL_ORIGIN: 'https://shopping-list.example.ts.net',
        RECEIPT_OCR_MODE: 'live',
      }),
    ).toThrow(/RECEIPT_OCR_MODE/);
  });

  it('rejects a non-positive OCR timeout', () => {
    expect(() =>
      readConfig({
        CANONICAL_ORIGIN: 'https://shopping-list.example.ts.net',
        RECEIPT_OCR_TIMEOUT_MS: '0',
      }),
    ).toThrow(/RECEIPT_OCR_TIMEOUT_MS/);
  });

  it('rejects an unassigned image retention policy', () => {
    expect(() =>
      readConfig({
        CANONICAL_ORIGIN: 'https://shopping-list.example.ts.net',
        RECEIPT_IMAGE_RETENTION: 'never',
      }),
    ).toThrow(/RECEIPT_IMAGE_RETENTION/);
  });

  it('rejects an origin that is not an origin-only URL', () => {
    expect(() =>
      readConfig({
        CANONICAL_ORIGIN: 'https://shopping-list.example.ts.net/app',
      }),
    ).toThrow(/must be an HTTP\(S\) origin/);
  });

  it('rejects an invalid port', () => {
    expect(() =>
      readConfig({ CANONICAL_ORIGIN: 'http://localhost:3000', PORT: '70000' }),
    ).toThrow(/PORT/);
  });
});
