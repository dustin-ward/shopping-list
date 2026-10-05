import { expect, test } from '@playwright/test';

test('shows item notes inline and expands or collapses long notes', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const itemName = `Rice item ${suffix}`;
  const noteText =
    'Please buy the extra-large bag of rice, keep it away from the damp storage shelf, and check the best-before date before adding it to the pantry. '.repeat(
      5,
    );

  await page.goto('/');
  await page.getByRole('button', { name: 'Open add item form' }).click();
  await page.getByLabel('Item name').fill(itemName);
  await page.getByText('Quantity, note, and groups').click();
  await page.getByLabel('Note').fill(noteText);
  await page.getByRole('button', { name: 'Add item', exact: true }).click();

  const item = page
    .getByRole('region', { name: 'Ungrouped' })
    .locator('.entry-card')
    .filter({ hasText: itemName });
  const note = item.locator('.entry-note');
  const noteTextControl = note.locator('summary');
  await expect(noteTextControl).toBeVisible();
  await expect(noteTextControl).toHaveText(noteText);
  expect(
    await item
      .locator('.entry-copy')
      .evaluate((element) =>
        element.children[1]?.classList.contains('entry-note'),
      ),
  ).toBe(true);

  const collapsedHeight = await noteTextControl.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  expect(collapsedHeight).toBeLessThan(44);
  await noteTextControl.click();
  await expect(note).toHaveAttribute('open', '');
  const expandedHeight = await noteTextControl.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  expect(expandedHeight).toBeGreaterThan(collapsedHeight);
  await noteTextControl.click();
  await expect(note).not.toHaveAttribute('open', '');

  await page.setViewportSize({ width: 900, height: 844 });
  const purchaseToggle = item.getByRole('checkbox', {
    name: `Mark ${itemName} as purchased in Ungrouped`,
  });
  const toggleBox = await purchaseToggle.boundingBox();
  const titleBox = await item.locator('.entry-title-row').boundingBox();
  expect(toggleBox?.width).toBeGreaterThanOrEqual(44);
  expect(Math.abs(toggleBox!.y - titleBox!.y)).toBeLessThan(2);
  const visualCheckboxSize = await purchaseToggle.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element, '::before').width),
  );
  expect(visualCheckboxSize).toBeLessThan(30);

  await page
    .getByRole('checkbox', {
      name: `Mark ${itemName} as purchased in Ungrouped`,
    })
    .click();
  await page.getByRole('button', { name: /Purchased/ }).click();
  const purchasedItem = page
    .locator('.purchased-card')
    .filter({ hasText: itemName });
  await expect(purchasedItem.locator('.entry-note summary')).toHaveText(
    noteText,
  );

  const plainItemName = `Plain item ${suffix}`;
  await page.getByRole('button', { name: 'Open add item form' }).click();
  await page.getByLabel('Item name').fill(plainItemName);
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  const plainItem = page
    .getByRole('region', { name: 'Ungrouped', exact: true })
    .locator('.entry-card')
    .filter({ hasText: plainItemName });
  await expect(plainItem.locator('.entry-note')).toHaveCount(0);
  const plainPurchaseToggle = plainItem.getByRole('checkbox', {
    name: `Mark ${plainItemName} as purchased in Ungrouped`,
  });
  const plainToggleBox = await plainPurchaseToggle.boundingBox();
  const plainTitleBox = await plainItem
    .locator('.entry-title-row')
    .boundingBox();
  expect(
    Math.abs(
      plainToggleBox!.y +
        plainToggleBox!.height / 2 -
        (plainTitleBox!.y + plainTitleBox!.height / 2),
    ),
  ).toBeLessThan(2);
});
