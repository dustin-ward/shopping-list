import { expect, test } from '@playwright/test';

test('separate browser contexts see additions through foreground polling', async ({
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
  const firstItem = `Shared ${crypto.randomUUID().slice(0, 8)}`;
  const secondItem = `Shared ${crypto.randomUUID().slice(0, 8)}`;

  try {
    await Promise.all([firstPage.goto('/'), secondPage.goto('/')]);
    await expect(
      firstPage.getByRole('button', { name: 'Open add item form' }),
    ).toBeVisible();
    await expect(
      secondPage.getByRole('button', { name: 'Open add item form' }),
    ).toBeVisible();

    await firstPage.getByRole('button', { name: 'Open add item form' }).click();
    await firstPage.getByLabel('Item name').fill(firstItem);
    await firstPage
      .getByRole('button', { name: 'Add item', exact: true })
      .click();
    await expect(
      secondPage.getByRole('checkbox', {
        name: `Mark ${firstItem} as purchased in Ungrouped`,
      }),
    ).toBeVisible({ timeout: 7_000 });

    await secondPage
      .getByRole('button', { name: 'Open add item form' })
      .click();
    await secondPage.getByLabel('Item name').fill(secondItem);
    await secondPage
      .getByRole('button', { name: 'Add item', exact: true })
      .click();
    await expect(
      firstPage.getByRole('checkbox', {
        name: `Mark ${secondItem} as purchased in Ungrouped`,
      }),
    ).toBeVisible({ timeout: 7_000 });
  } finally {
    await Promise.all([firstContext.close(), secondContext.close()]);
  }
});
