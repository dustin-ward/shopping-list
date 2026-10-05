import { expect, test } from '@playwright/test';

test('adds an item from a group with that group preselected', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const firstGroupName = `Target group ${suffix}`;
  const secondGroupName = `Other group ${suffix}`;
  const itemName = `Group-added item ${suffix}`;

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
  const targetGroup = page.getByRole('region', { name: firstGroupName });
  await targetGroup
    .getByRole('button', { name: `Add item to ${firstGroupName}` })
    .click();

  await expect(page.getByLabel('Item name')).toBeFocused();
  await expect(page.locator('details.item-details')).toHaveJSProperty(
    'open',
    true,
  );
  await page.getByLabel('Item name').fill(itemName);
  await expect(
    page.getByRole('checkbox', { name: firstGroupName }),
  ).toBeChecked();
  const additionalGroup = page.getByRole('checkbox', { name: secondGroupName });
  await expect(additionalGroup).not.toBeChecked();
  await additionalGroup.check();
  await page.getByRole('button', { name: 'Add item', exact: true }).click();

  await expect(
    targetGroup.getByRole('checkbox', {
      name: `Mark ${itemName} as purchased in ${firstGroupName}`,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: secondGroupName }).getByRole('checkbox', {
      name: `Mark ${itemName} as purchased in ${secondGroupName}`,
    }),
  ).toBeVisible();
});
