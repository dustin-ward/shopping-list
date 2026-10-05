import { expect, test } from '@playwright/test';

test('serves the ready health endpoint', async ({ request }) => {
  const response = await request.get('/healthz');

  expect(response.ok()).toBeTruthy();
  expect(await response.json()).toEqual({ status: 'ok' });
});

test('serves the prerendered application shell', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle('Shopping list');
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(navigation).toBeHidden();
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await expect(navigation).toBeVisible();
  await expect(
    navigation.getByRole('button', { name: 'List', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await navigation.getByRole('button', { name: 'Groups', exact: true }).click();
  await expect(navigation).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Groups' })).toBeVisible();
});

test('places connection status and refresh controls in the footer', async ({
  page,
}) => {
  await page.goto('/');

  await expect(page.locator('header .connection')).toHaveCount(0);
  const footer = page.locator('footer.device-data');
  await expect(footer.locator('.connection')).toBeVisible();
  await expect(footer.getByRole('button', { name: /Refresh/ })).toBeVisible();
});

test('fits the narrow mobile viewport without horizontal scrolling', async ({
  page,
}) => {
  await page.goto('/');

  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(widths.content).toBeLessThanOrEqual(widths.viewport);
});

test('keeps the add form collapsed until the plus button is opened', async ({
  page,
}) => {
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Open add item form' }),
  ).toBeVisible();
  await expect(page.getByLabel('Item name')).toHaveCount(0);

  await page.getByRole('button', { name: 'Open add item form' }).click();
  await expect(page.getByLabel('Item name')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByLabel('Item name')).toHaveCount(0);
});
