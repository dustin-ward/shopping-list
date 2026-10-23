import { expect, test, type Page } from '@playwright/test';

/**
 * The canonical-item admin surface: renaming a household term (and watching the
 * list adopt it), a merge blocked because both items are on the list, then the
 * merge itself once the conflict is gone — with the before/after report on
 * screen and the absorbed item no longer in the catalogue.
 */

async function openItems(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', { name: 'Items', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Items' })).toBeVisible();
}

async function openList(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', { name: 'List', exact: true }).click();
}

async function addItem(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Open add item form' }).click();
  await page.getByLabel('Item name').fill(name);
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
}

async function chooseMerge(page: Page, absorbed: string, survivor: string) {
  await page.getByRole('button', { name: `Merge ${absorbed} into…` }).click();
  await page
    .getByLabel(`Merge "${absorbed}" into`)
    .selectOption({ label: survivor });
  await page.getByRole('button', { name: 'Review merge' }).click();
  await expect(
    page.getByText(`Merge "${absorbed}" into "${survivor}"?`),
  ).toBeVisible();
}

test('renames and merges items with the counts on screen', async ({ page }) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const absorbed = `Absorbed item ${suffix}`;
  const survivor = `Survivor item ${suffix}`;
  const renamed = `Renamed item ${suffix}`;

  await page.goto('/');
  await addItem(page, absorbed);
  await addItem(page, survivor);

  // Rename the survivor: the household term moves, and the List's copy of the
  // visible entry adopts it.
  await openItems(page);
  await page.getByRole('button', { name: `Rename ${survivor}` }).click();
  await page.getByLabel('New household term').fill(renamed);
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(
    page.getByText(`Renamed "${survivor}" to "${renamed}".`),
  ).toBeVisible();
  await expect(
    page.locator('.item-card').filter({ hasText: renamed }),
  ).toBeVisible();

  await openList(page);
  await expect(page.getByText(renamed, { exact: true })).toBeVisible();

  // Both items are on the list, so the schema's one-active-entry rule stops the
  // merge and says what to do about it.
  await openItems(page);
  await chooseMerge(page, absorbed, renamed);
  await page
    .getByRole('button', { name: `Merge ${absorbed} into ${renamed}` })
    .click();
  await expect(
    page.getByRole('alert').filter({
      hasText: `Both "${absorbed}" and "${renamed}" are on the list.`,
    }),
  ).toBeVisible();
  await expect(
    page.locator('.item-card').filter({ hasText: absorbed }),
  ).toBeVisible();

  // Remove the absorbed item from the list, then merge.
  await openList(page);
  const ungrouped = page.getByRole('region', { name: 'Ungrouped' });
  await ungrouped.getByRole('button', { name: `Remove ${absorbed}` }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Remove from list' })
    .click();
  await expect(ungrouped.getByText(absorbed, { exact: true })).toHaveCount(0);

  await openItems(page);
  await chooseMerge(page, absorbed, renamed);
  await page
    .getByRole('button', { name: `Merge ${absorbed} into ${renamed}` })
    .click();

  // The report proves the move: nothing is left on the absorbed item, and the
  // alias/entry counts read on the survivor.
  await expect(
    page.getByRole('heading', {
      name: `Merged "${absorbed}" into "${renamed}"`,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(`Nothing is left on "${absorbed}"`),
  ).toBeVisible();
  const audit = page.getByRole('table', {
    name: 'Reference counts: before and after',
  });
  await expect(audit).toBeVisible();
  await expect(
    audit.getByRole('row', { name: /^List entries/ }).getByRole('cell'),
  ).toHaveText(['1', '0', '1', '2']);
  await expect(
    page.getByText(
      `Matching learns "${absorbed}" for "${renamed}", so the absorbed phrase still resolves.`,
    ),
  ).toBeVisible();
  await expect(
    page.locator('.item-card').filter({ hasText: absorbed }),
  ).toHaveCount(0);

  // The list renders one entry, under the surviving term.
  await openList(page);
  await expect(page.getByText(renamed, { exact: true })).toBeVisible();
  await expect(page.getByText(absorbed, { exact: true })).toHaveCount(0);
});
