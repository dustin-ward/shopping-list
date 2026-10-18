import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { featureOnOrigin } from './servers';

// This spec drives the feature-enabled server (see playwright.config.ts).
test.use({ baseURL: featureOnOrigin });
test.use({
  // adapter-node derives the request protocol from `x-forwarded-proto` and
  // defaults to https, so over this plain-HTTP origin SvelteKit's CSRF check
  // rejects the multipart upload before any hook runs. A real deployment sits
  // behind Tailscale Serve over HTTPS (operations.md) and the proxy sets the
  // header; the browser has to add it here — the same accommodation the
  // API-level upload helper below makes by hand.
  extraHTTPHeaders: { 'x-forwarded-proto': 'http' },
});

const image = readFileSync(
  resolve(process.cwd(), 'tests/fixtures/receipts/e2e-receipt.png'),
);

// A 32×64 JPEG tagged Orientation=6 (rotate 90° CW) with a GPS IFD. A correct
// capture must land as 64×32 with the EXIF block — GPS included — gone.
const taggedPhotoPath = resolve(
  process.cwd(),
  'tests/fixtures/receipts/capture-exif.jpg',
);

/** Open the app and land on the Receipts tab. */
async function openReceiptsTab(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', { name: 'Receipts', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Receipts' })).toBeVisible();
}

/**
 * How many receipts the server has for this list. The tab renders its own copy,
 * so counting here keeps assertions free of the list's load timing.
 */
async function receiptCount(request: APIRequestContext): Promise<number> {
  const response = await request.get('/api/receipts');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { items: unknown[] };
  return body.items.length;
}

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

test('captures through the file input: EXIF GPS stripped, orientation kept', async ({
  page,
  request,
}) => {
  // Guard the fixture: the tag really is in the bytes the client receives.
  expect(readFileSync(taggedPhotoPath).toString('latin1')).toContain(
    'EXIF-GPS-PRESENT',
  );

  await openReceiptsTab(page);
  const cards = page.locator('.receipt-list .receipt-card');
  const before = await receiptCount(request);

  await page.locator('input[type="file"]').setInputFiles(taggedPhotoPath);
  await expect(page.locator('.capture-notice')).toContainText(
    'Receipt captured',
    { timeout: 15_000 },
  );
  await expect(cards).toHaveCount(before + 1);

  // The newest receipt is the capture; its stored image must be the client's
  // re-encode, not the camera original.
  await cards.first().locator('button').click();
  await expect(
    page.getByRole('img', { name: 'Scanned receipt' }),
  ).toBeVisible();
  const src = await page.locator('.receipt-image img').getAttribute('src');
  expect(src).toMatch(/^\/api\/receipts\/[0-9a-f-]+\/image$/u);

  const stored = await page.evaluate(async (url) => {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const bitmap = await createImageBitmap(new Blob([bytes]));
    const { width, height } = bitmap;
    bitmap.close();
    return {
      width,
      height,
      text: new TextDecoder('latin1').decode(bytes),
    };
  }, src ?? '');

  // Orientation 6 turns the portrait original (32×64) into landscape.
  expect(stored.width).toBe(64);
  expect(stored.height).toBe(32);
  expect(stored.text).not.toContain('Exif');
  expect(stored.text).not.toContain('EXIF-GPS-PRESENT');
});

test('reports the same photo a second time as already captured', async ({
  page,
  request,
}) => {
  await openReceiptsTab(page);

  // The capture test above may already have sent this fixture, so the first
  // upload is allowed to be a fresh capture or a duplicate.
  await page.locator('input[type="file"]').setInputFiles(taggedPhotoPath);
  await expect(page.locator('.capture-notice')).toContainText(
    /Receipt captured|already captured/,
    { timeout: 15_000 },
  );
  const afterFirst = await receiptCount(request);

  // Identical bytes dedupe server-side instead of creating a second receipt.
  await page.locator('input[type="file"]').setInputFiles(taggedPhotoPath);
  await expect(page.locator('.capture-notice')).toContainText(
    'already captured',
    { timeout: 15_000 },
  );
  expect(await receiptCount(request)).toBe(afterFirst);
});

test('rejects a file that is not a photo before uploading it', async ({
  page,
  request,
}) => {
  await openReceiptsTab(page);
  const before = await receiptCount(request);

  await page.locator('input[type="file"]').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('definitely not a receipt photo'),
  });

  await expect(page.locator('.capture-error')).toContainText("isn't a photo");
  expect(await receiptCount(request)).toBe(before);
});

test('hides capture while the device is offline', async ({ page }) => {
  await openReceiptsTab(page);
  const captureButton = page.getByRole('button', {
    name: 'Capture receipt',
    exact: true,
  });
  await expect(captureButton).toBeVisible();

  await page.context().setOffline(true);
  // The snapshot poll notices the dropped connection (canWrite → false).
  await expect(captureButton).toHaveCount(0, { timeout: 15_000 });

  await page.context().setOffline(false);
});
