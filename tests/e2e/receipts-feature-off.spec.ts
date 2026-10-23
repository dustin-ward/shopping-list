import { expect, test } from '@playwright/test';

// The default server runs with RECEIPT_OCR_URL unset (the feature off), so the
// Receipts tab must not exist.
test('hides the Receipts tab while the feature is off', async ({ page }) => {
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Open add item form' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await expect(
    page.getByRole('button', { name: 'Receipts', exact: true }),
  ).toHaveCount(0);
});
