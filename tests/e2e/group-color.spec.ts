import { expect, test } from '@playwright/test';

test('creates and edits a group color', async ({ page }) => {
  const groupName = `Color ${crypto.randomUUID().slice(0, 8)}`;
  const createdColor = '#487ca8';
  const editedColor = '#b36a44';

  await page.goto('/');
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', { name: 'Groups', exact: true }).click();

  await page.getByLabel('New group name').fill(groupName);
  await page.getByLabel('New group color').fill(createdColor);
  await page.getByRole('button', { name: 'Create group' }).click();
  await expect(page.getByText(groupName, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const groupPanel = page.getByRole('region', { name: groupName });
  await expect(groupPanel).toHaveCSS('border-left-color', 'rgb(72, 124, 168)');

  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', { name: 'Groups', exact: true }).click();
  await page.getByRole('button', { name: `Edit ${groupName}` }).click();
  await page.getByLabel(`Color for ${groupName}`).fill(editedColor);
  const saveButton = page.getByRole('button', { name: 'Save', exact: true });
  await saveButton.click();
  await expect
    .poll(async () => {
      if (!(await saveButton.isVisible())) return 'saved';
      return (await saveButton.isEnabled()) ? 'conflict' : 'saving';
    })
    .not.toBe('saving');
  if (await saveButton.isVisible()) {
    await expect(page.getByRole('alert')).toContainText(
      'changed on another device',
    );
    await saveButton.click();
  }
  await expect(page.getByText(groupName, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(groupPanel).toHaveCSS('border-left-color', 'rgb(179, 106, 68)');
});
