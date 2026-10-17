import { defineConfig } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  featureOffOrigin,
  featureOffPort,
  featureOnOrigin,
  featureOnPort,
} from './tests/e2e/servers';

// The receipt feature is enabled by RECEIPT_OCR_URL, so its browser flow needs
// a server started with that flag. Two servers run side by side: the default
// one proves the tab is hidden while the feature is off, this one exercises it.
const receiptStorageDir = join(
  tmpdir(),
  `shopping-list-e2e-receipts-${process.pid}`,
);
mkdirSync(receiptStorageDir, { recursive: true });

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  // E2E tests share servers and SQLite databases, so mutations must be serialized.
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: featureOffOrigin,
    viewport: { width: 390, height: 844 },
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node scripts/start.mjs',
      url: `${featureOffOrigin}/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        DATABASE_PATH: join(
          tmpdir(),
          `shopping-list-e2e-off-${process.pid}.sqlite`,
        ),
        CANONICAL_ORIGIN: featureOffOrigin,
        PORT: String(featureOffPort),
      },
    },
    {
      command: 'node scripts/start.mjs',
      url: `${featureOnOrigin}/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        DATABASE_PATH: join(
          tmpdir(),
          `shopping-list-e2e-on-${process.pid}.sqlite`,
        ),
        CANONICAL_ORIGIN: featureOnOrigin,
        PORT: String(featureOnPort),
        RECEIPT_OCR_URL: 'http://receipt-ocr.invalid/ocr',
        RECEIPT_OCR_MODE: 'stub',
        RECEIPT_STORAGE_DIR: receiptStorageDir,
        // adapter-node defaults the request protocol to https, which makes
        // SvelteKit's CSRF check reject multipart uploads made over the plain
        // HTTP e2e origin. Trusting the forwarded protocol lets the receipts
        // spec upload directly; production is HTTPS and unaffected.
        PROTOCOL_HEADER: 'x-forwarded-proto',
      },
    },
  ],
});
