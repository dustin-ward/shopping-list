/**
 * Capture the golden receipt fixtures from a running OCR sidecar (plan §12).
 *
 * Each committed `<stem>.png` is POSTed to the sidecar the way the worker does,
 * and the response is written verbatim to `<stem>.json`. The matching
 * `<stem>.expected.json` goldens are asserted by the unit suite, so a refresh
 * surfaces as a diff to review rather than a silent change.
 *
 * Usage: node scripts/capture-receipt-fixtures.mjs [ocrUrl]
 * The URL defaults to RECEIPT_OCR_URL, then the dev compose profile's published
 * endpoint. The four stems are the plan's clean, wrapped two-column, coupons,
 * and washed-out failure cases.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = join(projectRoot, 'tests/fixtures/receipts');

const STEMS = [
  'clean-grocery',
  'wrapped-two-column',
  'coupons-negatives',
  'washed-out',
];

const url =
  process.argv[2] ?? process.env.RECEIPT_OCR_URL ?? 'http://localhost:8080/ocr';

/**
 * Capture one stem's image and write its payload next to it.
 *
 * @param {string} stem
 */
async function capture(stem) {
  const image = readFileSync(join(fixturesDir, `${stem}.png`));
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: image,
  });
  if (!response.ok) {
    throw new Error(
      `${stem}: the sidecar at ${url} responded with HTTP ${response.status}`,
    );
  }

  const payload = await response.text();
  // Refuse to overwrite a fixture with anything that is not the OCR shape.
  JSON.parse(payload);
  const body = payload.endsWith('\n') ? payload : `${payload}\n`;
  writeFileSync(join(fixturesDir, `${stem}.json`), body);
  console.info(`Captured ${stem}.json (${body.length} bytes)`);
}

for (const stem of STEMS) {
  await capture(stem);
}
