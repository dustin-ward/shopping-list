import { expect, test } from '@playwright/test';

test('purchase in one group hides other copies and undo restores memberships', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const firstGroupName = `Category ${suffix}`;
  const secondGroupName = `Store ${suffix}`;
  const itemName = `Shared item ${suffix}`;

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
  await page.getByLabel('Type').selectOption('store');
  await page.getByRole('button', { name: 'Create group' }).click();
  await expect(page.getByText(secondGroupName, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const toolbarButtons = await Promise.all([
    page.getByRole('button', { name: 'Open add item form' }).boundingBox(),
    page.getByRole('button', { name: 'Edit group order' }).boundingBox(),
    page.getByRole('button', { name: 'Open navigation menu' }).boundingBox(),
  ]);
  expect(toolbarButtons.every((box) => box !== null)).toBe(true);
  expect(toolbarButtons[0]!.x).toBeLessThan(toolbarButtons[1]!.x);
  expect(toolbarButtons[1]!.x).toBeLessThan(toolbarButtons[2]!.x);
  expect(
    Math.max(...toolbarButtons.map((box) => box!.y)) -
      Math.min(...toolbarButtons.map((box) => box!.y)),
  ).toBeLessThan(2);

  const groupSections = page.locator('.group-list-section');
  const groupOrder = (await groupSections.locator('h2').allTextContents()).map(
    (name) => name.trim(),
  );
  const secondGroupPosition = groupOrder.indexOf(secondGroupName);
  expect(secondGroupPosition).toBeGreaterThan(0);
  const previousGroupName = groupOrder[secondGroupPosition - 1];

  await expect(
    page.getByRole('button', { name: `Move ${secondGroupName} up` }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit group order' }).click();
  await page
    .getByRole('button', { name: `Move ${secondGroupName} up` })
    .click();
  await expect(
    groupSections.nth(secondGroupPosition - 1).locator('h2'),
  ).toHaveText(secondGroupName);
  await expect(groupSections.nth(secondGroupPosition).locator('h2')).toHaveText(
    previousGroupName!,
  );
  await page
    .getByRole('button', { name: 'Finish editing group order' })
    .click();

  await page.getByRole('button', { name: 'Open add item form' }).click();
  await page.getByLabel('Item name').fill(itemName);
  await page.getByText('Quantity, note, and groups').click();
  await page.getByRole('checkbox', { name: firstGroupName }).check();
  await page.getByRole('checkbox', { name: secondGroupName }).check();
  await page.getByRole('button', { name: 'Add item', exact: true }).click();

  const firstGroup = page.getByRole('region', { name: firstGroupName });
  const secondGroup = page.getByRole('region', { name: secondGroupName });
  const itemCheckbox = (group: typeof firstGroup, groupName: string) =>
    group.getByRole('checkbox', {
      name: `Mark ${itemName} as purchased in ${groupName}`,
    });

  await expect(itemCheckbox(firstGroup, firstGroupName)).toBeVisible();
  await expect(itemCheckbox(secondGroup, secondGroupName)).toBeVisible();

  const editButton = firstGroup.getByRole('button', {
    name: `Edit ${itemName}`,
  });
  const removeButton = firstGroup.getByRole('button', {
    name: `Remove ${itemName}`,
  });
  const editBox = await editButton.boundingBox();
  const removeBox = await removeButton.boundingBox();
  expect(editBox).not.toBeNull();
  expect(removeBox).not.toBeNull();
  expect(Math.abs(editBox!.y - removeBox!.y)).toBeLessThan(2);

  await firstGroup
    .getByRole('button', { name: `Collapse ${firstGroupName}` })
    .click();
  await expect(itemCheckbox(firstGroup, firstGroupName)).toHaveCount(0);
  await expect(itemCheckbox(secondGroup, secondGroupName)).toBeVisible();
  await firstGroup
    .getByRole('button', { name: `Expand ${firstGroupName}` })
    .click();
  await expect(itemCheckbox(firstGroup, firstGroupName)).toBeVisible();

  await itemCheckbox(firstGroup, firstGroupName).click();
  await expect(itemCheckbox(firstGroup, firstGroupName)).toHaveCount(0);
  await expect(itemCheckbox(secondGroup, secondGroupName)).toHaveCount(0);

  await page.getByRole('button', { name: /Purchased/ }).click();
  await page
    .getByRole('button', { name: `Undo purchase of ${itemName}` })
    .click();
  await expect(itemCheckbox(firstGroup, firstGroupName)).toBeVisible();
  await expect(itemCheckbox(secondGroup, secondGroupName)).toBeVisible();
});
