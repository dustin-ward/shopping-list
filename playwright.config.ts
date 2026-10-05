import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = 4173;
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  // E2E tests share one server and SQLite database, so mutations must be serialized.
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: origin,
    viewport: { width: 390, height: 844 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node scripts/start.mjs',
    url: `${origin}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_PATH: join(tmpdir(), `shopping-list-e2e-${process.pid}.sqlite`),
      CANONICAL_ORIGIN: origin,
      PORT: String(port),
    },
  },
});
