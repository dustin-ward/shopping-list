import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { featureOnOrigin } from './servers';

// This spec drives the feature-enabled server (see playwright.config.ts).
test.use({ baseURL: featureOnOrigin });

const image = readFileSync(
  resolve(process.cwd(), 'tests/fixtures/receipts/e2e-receipt.png'),
);

/**
 * Upload one real PNG straight to the read API, the way the worker is fed. A
 * repeat upload of identical bytes dedupes to the existing receipt (200), so
 * both codes are success here.
 */
async function capture(request: APIRequestContext): Promise<string> {
  const response = await request.post('/api/receipts', {
    headers: { origin: featureOnOrigin, 'x-forwarded-proto': 'http' },
    multipart: {
      image: { name: 'receipt.png', mimeType: 'image/png', buffer: image },
    },
  });
  expect([200, 201]).toContain(response.status());
  const body = (await response.json()) as { id: string };
  return body.id;
}

test('captures a receipt, lists it, and flips pending to review in the open view', async ({
  page,
  request,
}) => {
  await capture(request);

  await page.goto('/');
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', { name: 'Receipts', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Receipts' })).toBeVisible();

  const card = page.locator('.receipt-list .receipt-open').first();
  await expect(card).toBeVisible();
  await card.click();

  await expect(
    page.getByRole('img', { name: 'Scanned receipt' }),
  ).toBeVisible();

  // Prove the detail view reaches `review` by polling, not by a reload: the
  // marker survives only while the document is not reloaded.
  await page.evaluate(() => {
    (window as unknown as { __receiptsNoReload?: boolean }).__receiptsNoReload =
      true;
  });
  await expect(page.locator('.receipt-detail .status-chip')).toHaveText(
    'Review needed',
    { timeout: 15_000 },
  );
  await expect(page.locator('.ocr-text')).toContainText('CORNER MARKET');
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __receiptsNoReload?: boolean })
          .__receiptsNoReload,
    ),
  ).toBe(true);
});

test('serves the receipt image same-origin without caching', async ({
  request,
}) => {
  const id = await capture(request);

  const response = await request.get(`/api/receipts/${id}/image`);

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('image/png');
  expect(response.headers()['cache-control']).toBe('no-store');
});
