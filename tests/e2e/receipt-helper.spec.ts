import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { helperOrigin } from './servers';

// This spec drives the third server (see playwright.config.ts): its stub OCR
// replays the washed-out fixture — the capture the deterministic parser marks
// low confidence — and its stub helper replays a committed second reading.
test.use({ baseURL: helperOrigin });
test.use({
  // adapter-node derives the protocol from `x-forwarded-proto` and defaults to
  // https, so the plain-HTTP e2e origin has to claim it explicitly; the upload
  // helper below does the same by hand.
  extraHTTPHeaders: { 'x-forwarded-proto': 'http' },
});

const image = readFileSync(
  resolve(process.cwd(), 'tests/fixtures/receipts/e2e-receipt.png'),
);

/**
 * Capture a receipt the stub OCR reads as the washed-out fixture. The tag
 * makes the bytes unique, so this is always a fresh receipt and the newest in
 * the list rather than a dedupe of an earlier run.
 */
async function captureWashedOut(request: APIRequestContext): Promise<string> {
  const snapshotResponse = await request.get('/api/snapshot');
  expect(snapshotResponse.ok()).toBe(true);
  const { serverInstanceId } = (await snapshotResponse.json()) as {
    serverInstanceId: string;
  };
  const response = await request.post('/api/receipts', {
    headers: {
      origin: helperOrigin,
      'x-forwarded-proto': 'http',
      'x-server-instance-id': serverInstanceId,
    },
    multipart: {
      image: {
        name: 'receipt.png',
        mimeType: 'image/png',
        buffer: Buffer.concat([
          image,
          Buffer.from(`\n#helper-${randomUUID()}\n`),
        ]),
      },
    },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/** Open the app, land on Receipts, and open the newest receipt in review. */
async function openNewestReceipt(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', { name: 'Receipts', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Receipts' })).toBeVisible();
  await page.locator('.receipt-list .receipt-open').first().click();
  await expect(page.locator('.receipt-detail .status-chip')).toHaveText(
    'Review needed',
    { timeout: 15_000 },
  );
}

test('offers the fallback helper on a low-confidence parse and replaces only the parsed lines', async ({
  page,
  request,
}) => {
  const receiptId = await captureWashedOut(request);
  await openNewestReceipt(page);

  // The deterministic parse struggled: one item row and thirteen parked rows,
  // no totals, and the raw OCR text is kept underneath.
  await expect(page.locator('.receipt-lines .receipt-line')).toHaveCount(14);
  // One mangled item price was read; neither subtotal nor total was.
  await expect(page.locator('.totals-strip .totals-subtotal')).toHaveText('—');
  await expect(page.locator('.totals-strip .totals-total')).toHaveText('—');
  await expect(page.locator('.ocr-text')).toContainText('NANAS');

  // Review names why the second reading is worth offering.
  const offer = page.locator('.helper-reparse');
  await expect(offer).toBeVisible();
  await expect(offer.locator('.helper-heading')).toHaveText(
    'This receipt was hard to read',
  );
  await expect(offer.locator('.helper-reasons li')).toHaveCount(2);
  await expect(offer.locator('.helper-reasons')).toContainText(
    'no price column was found',
  );
  await expect(offer.locator('.helper-reasons')).toContainText(
    'no subtotal or total was found',
  );

  // One tap asks; the request is never sent until the second tap confirms,
  // and cancelling leaves the parse exactly as it was.
  await offer.getByRole('button', { name: 'Re-parse with helper' }).click();
  await expect(offer.locator('.helper-confirm')).toContainText(
    'The photo and the raw OCR text are kept',
  );
  await offer.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.helper-reparse .helper-confirm')).toHaveCount(0);
  await expect(page.locator('.receipt-lines .receipt-line')).toHaveCount(14);

  await offer.getByRole('button', { name: 'Re-parse with helper' }).click();
  await offer.getByRole('button', { name: 'Replace the lines' }).click();

  // The helper's six lines replace the fourteen, with its totals in the strip.
  await expect(page.locator('.receipt-lines .receipt-line')).toHaveCount(6, {
    timeout: 15_000,
  });
  await expect(
    page.locator('.receipt-line', { hasText: 'MILK 2% 1L' }),
  ).toContainText('MILK 2% 1L');
  const strip = page.locator('.totals-strip');
  await expect(strip.locator('.totals-subtotal')).toContainText('8.92');
  await expect(strip.locator('.totals-tax')).toContainText('0.54');
  await expect(strip.locator('.totals-total')).toContainText('9.46');

  // The receipt is still in review, the offer is spent, and the raw artifacts
  // — the photo and the OCR text — were never rewritten.
  await expect(page.locator('.receipt-detail .status-chip')).toHaveText(
    'Review needed',
  );
  await expect(page.locator('.helper-reparse')).toHaveCount(0);
  await expect(page.locator('.ocr-text')).toContainText('NANAS');
  await expect(page.locator('.receipt-image img')).toHaveCount(1);

  const detail = (await (
    await request.get(`/api/receipts/${receiptId}`)
  ).json()) as {
    lines: { rawText: string }[];
    ocrText: string | null;
    imageAvailable: boolean;
    parseQuality: { helperApplied: boolean; lowConfidence: boolean };
  };
  expect(detail.lines).toHaveLength(6);
  expect(detail.ocrText).toContain('NANAS');
  expect(detail.imageAvailable).toBe(true);
  expect(detail.parseQuality).toMatchObject({
    helperApplied: true,
    lowConfidence: false,
  });
});

test('leaves the offer off a receipt the helper already re-parsed', async ({
  page,
  request,
}) => {
  // One receipt is re-parsed through the API, then reopened: the reload path
  // proves the suppression is stored state, not a transient client flag.
  const receiptId = await captureWashedOut(request);
  // The capture returns while the worker is still reading; the parse (and the
  // `updatedAt` the reparse must echo) only settles once it reaches review.
  await expect
    .poll(
      async () => {
        const response = await request.get(`/api/receipts/${receiptId}`);
        return ((await response.json()) as { status: string }).status;
      },
      { timeout: 15_000 },
    )
    .toBe('review');
  const detail = (await (
    await request.get(`/api/receipts/${receiptId}`)
  ).json()) as { updatedAt: string; status: string };
  const snapshot = (await (await request.get('/api/snapshot')).json()) as {
    serverInstanceId: string;
  };

  const reparsed = await request.post(`/api/receipts/${receiptId}/reparse`, {
    headers: {
      origin: helperOrigin,
      'x-forwarded-proto': 'http',
      'content-type': 'application/json',
    },
    data: {
      serverInstanceId: snapshot.serverInstanceId,
      expectedUpdatedAt: detail.updatedAt,
    },
  });
  expect(reparsed.ok()).toBe(true);
  expect(
    ((await reparsed.json()) as { parseQuality: { helperApplied: boolean } })
      .parseQuality.helperApplied,
  ).toBe(true);

  await openNewestReceipt(page);
  await expect(page.locator('.receipt-lines .receipt-line')).toHaveCount(6);
  await expect(page.locator('.helper-reparse')).toHaveCount(0);
});
