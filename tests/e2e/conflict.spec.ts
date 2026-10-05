import { expect, test } from '@playwright/test';

test('keeps a conflicting edit draft while showing the newer server value', async ({
  browser,
}) => {
  test.setTimeout(15_000);
  const firstContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const secondContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const firstPage = await firstContext.newPage();
  const secondPage = await secondContext.newPage();
  const itemName = `Conflict ${crypto.randomUUID().slice(0, 8)}`;

  try {
    await Promise.all([firstPage.goto('/'), secondPage.goto('/')]);
    await firstPage.getByRole('button', { name: 'Open add item form' }).click();
    await firstPage.getByLabel('Item name').fill(itemName);
    await firstPage
      .getByRole('button', { name: 'Add item', exact: true })
      .click();
    await expect(
      secondPage.getByRole('button', { name: `Edit ${itemName}` }),
    ).toBeVisible({ timeout: 7_000 });

    await secondPage.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await secondPage.getByRole('button', { name: `Edit ${itemName}` }).click();
    await secondPage
      .locator('.edit-form input')
      .first()
      .fill('Draft from device B');

    await firstPage.getByRole('button', { name: `Edit ${itemName}` }).click();
    await firstPage
      .locator('.edit-form input')
      .first()
      .fill('Saved by device A');
    await firstPage.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      firstPage.getByRole('checkbox', {
        name: 'Mark Saved by device A as purchased in Ungrouped',
      }),
    ).toBeVisible();

    await secondPage.getByRole('button', { name: 'Save changes' }).click();
    await expect(secondPage.getByRole('alert')).toContainText(
      'changed on another device',
    );
    await expect(secondPage.locator('.edit-form input').first()).toHaveValue(
      'Draft from device B',
    );
    await secondPage
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    await expect(
      secondPage.getByRole('checkbox', {
        name: 'Mark Saved by device A as purchased in Ungrouped',
      }),
    ).toBeVisible();
  } finally {
    await Promise.all([firstContext.close(), secondContext.close()]);
  }
});
