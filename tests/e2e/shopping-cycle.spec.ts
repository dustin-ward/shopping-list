import { expect, test } from '@playwright/test';

test('completes a store purchase, undo, clear, and historical lookup', async ({
  page,
}) => {
  const itemName = `E2E item ${crypto.randomUUID().slice(0, 8)}`;

  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Open add item form' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', { name: 'Groups', exact: true }).click();
  await page.getByLabel('New group name').fill('E2E Market');
  await page.getByLabel('Type').selectOption('store');
  await page.getByRole('button', { name: 'Create group' }).click();
  await expect(page.getByText('E2E Market')).toBeVisible();

  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await page.getByRole('button', { name: 'Open add item form' }).click();
  await page.getByLabel('Item name').fill(itemName);
  await page.getByText('Quantity, note, and groups').click();
  await page.getByRole('checkbox', { name: 'E2E Market' }).check();
  await page.getByLabel('Quantity').fill('2 packs');
  await page.getByLabel('Note').fill('Unsalted');
  await expect(
    page.getByRole('checkbox', { name: 'E2E Market' }),
  ).toBeChecked();
  await page.getByRole('button', { name: 'Add item', exact: true }).click();

  const purchaseControl = page.getByRole('checkbox', {
    name: `Mark ${itemName} as purchased in E2E Market`,
  });
  await expect(purchaseControl).toBeVisible();
  const targetSize = await purchaseControl.boundingBox();
  expect(targetSize?.width).toBeGreaterThanOrEqual(44);
  expect(targetSize?.height).toBeGreaterThanOrEqual(44);
  await purchaseControl.click();
  await page.getByRole('button', { name: /Purchased/ }).click();
  await expect(page.getByText('Bought at E2E Market')).toBeVisible();
  await page
    .getByRole('button', { name: `Undo purchase of ${itemName}` })
    .click();
  await expect(
    page.getByRole('checkbox', {
      name: `Mark ${itemName} as purchased in E2E Market`,
    }),
  ).toBeVisible();

  await page
    .getByRole('checkbox', {
      name: `Mark ${itemName} as purchased in E2E Market`,
    })
    .click();
  await page.getByRole('button', { name: /^Clear \d+ purchased$/ }).click();
  const clearDialog = page.getByRole('dialog');
  await expect(clearDialog).toBeVisible();
  await clearDialog
    .getByRole('button', { name: /^Clear \d+ purchased$/ })
    .click();
  await expect(
    page.getByRole('checkbox', {
      name: `Mark ${itemName} as purchased in E2E Market`,
    }),
  ).toHaveCount(0);

  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page
    .getByRole('button', { name: 'Purchase history', exact: true })
    .click();
  await expect(page.getByText(itemName)).toBeVisible();
  await expect(page.getByText('Bought at E2E Market')).toBeVisible();
});
