import { expect, test } from '@playwright/test';

test('removes an item from one group or from the entire list', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const firstGroupName = `Removal group ${suffix}`;
  const secondGroupName = `Other removal group ${suffix}`;
  const itemName = `Removable item ${suffix}`;

  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Open add item form' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', { name: 'Groups', exact: true }).click();
  await page.getByLabel('New group name').fill(firstGroupName);
  await page.getByRole('button', { name: 'Create group' }).click();
  await expect(page.getByText(firstGroupName, { exact: true })).toBeVisible();
  await page.getByLabel('New group name').fill(secondGroupName);
  await page.getByRole('button', { name: 'Create group' }).click();
  await expect(page.getByText(secondGroupName, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await page.getByRole('button', { name: 'Open add item form' }).click();
  await page.getByLabel('Item name').fill(itemName);
  await page.getByText('Quantity, note, and groups').click();
  await page
    .getByRole('checkbox', { name: firstGroupName, exact: true })
    .check();
  await page
    .getByRole('checkbox', { name: secondGroupName, exact: true })
    .check();
  await page.getByRole('button', { name: 'Add item', exact: true }).click();

  const firstGroup = page.getByRole('region', {
    name: firstGroupName,
    exact: true,
  });
  const secondGroup = page.getByRole('region', {
    name: secondGroupName,
    exact: true,
  });
  const firstCopy = firstGroup.getByRole('checkbox', {
    name: `Mark ${itemName} as purchased in ${firstGroupName}`,
  });
  const secondCopy = secondGroup.getByRole('checkbox', {
    name: `Mark ${itemName} as purchased in ${secondGroupName}`,
  });
  const removeDialog = page.getByRole('dialog');

  await firstGroup.getByRole('button', { name: `Remove ${itemName}` }).click();
  await expect(removeDialog).toBeVisible();
  await expect(
    removeDialog.getByRole('button', { name: 'Remove from all groups' }),
  ).toBeVisible();
  await removeDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(removeDialog).toBeHidden();
  await expect(firstCopy).toBeVisible();
  await expect(secondCopy).toBeVisible();

  await firstGroup.getByRole('button', { name: `Remove ${itemName}` }).click();
  await removeDialog
    .getByRole('button', { name: `Remove from ${firstGroupName} only` })
    .click();
  await expect(firstCopy).toHaveCount(0);
  await expect(secondCopy).toBeVisible();

  await secondGroup.getByRole('button', { name: `Remove ${itemName}` }).click();
  await removeDialog
    .getByRole('button', { name: 'Remove from all groups' })
    .click();
  await expect(secondCopy).toHaveCount(0);

  const ungroupedItemName = `Ungrouped removal ${suffix}`;
  await page.getByRole('button', { name: 'Open add item form' }).click();
  await page.getByLabel('Item name').fill(ungroupedItemName);
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  const ungrouped = page.getByRole('region', {
    name: 'Ungrouped',
    exact: true,
  });
  await ungrouped
    .getByRole('button', { name: `Remove ${ungroupedItemName}` })
    .click();
  await expect(removeDialog).toBeVisible();
  await expect(
    removeDialog.getByRole('button', { name: 'Remove from list' }),
  ).toBeVisible();
  await removeDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(
    ungrouped.getByRole('checkbox', {
      name: `Mark ${ungroupedItemName} as purchased in Ungrouped`,
    }),
  ).toBeVisible();
});
