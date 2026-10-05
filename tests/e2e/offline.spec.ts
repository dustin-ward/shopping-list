import { expect, test } from '@playwright/test';

test('opens the saved list read-only offline and resumes after reconnect', async ({
  page,
}) => {
  test.setTimeout(20_000);
  page.on('dialog', (dialog) => dialog.accept());
  const itemName = `Offline ${crypto.randomUUID().slice(0, 8)}`;

  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Open add item form' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Open add item form' }).click();
  await page.getByLabel('Item name').fill(itemName);
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  await expect(page.getByText(itemName)).toBeVisible();

  await page.waitForFunction(async (name) => {
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller)
      return false;
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('shopping-list-offline', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = await new Promise<
      { snapshot?: { entries?: Array<{ name: string }> } } | undefined
    >((resolve, reject) => {
      const request = database
        .transaction('snapshot')
        .objectStore('snapshot')
        .get('current-list');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return (
      result?.snapshot?.entries?.some((entry) => entry.name === name) ?? false
    );
  }, itemName);

  await page.context().setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText(itemName)).toBeVisible();
  await expect(page.locator('.offline-banner')).toContainText(
    'Offline — last refreshed',
  );
  await expect(
    page.getByRole('checkbox', {
      name: `Mark ${itemName} as purchased in Ungrouped`,
    }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Open add item form' }),
  ).toBeDisabled();
  const apiIsNotCached = await page.evaluate(async () => {
    try {
      await fetch('/api/snapshot', { cache: 'no-store' });
      return false;
    } catch {
      return true;
    }
  });
  expect(apiIsNotCached).toBe(true);

  await page.context().setOffline(false);
  await expect(
    page.getByRole('status').filter({ hasText: 'Connected' }),
  ).toBeVisible({ timeout: 7_000 });
  await expect(
    page.getByRole('checkbox', {
      name: `Mark ${itemName} as purchased in Ungrouped`,
    }),
  ).toBeEnabled();

  await page
    .getByRole('button', { name: /Clear this device’s saved data/ })
    .click();
  await expect(
    page.getByText(
      /Offline reopening requires another successful online visit/,
    ),
  ).toBeVisible();
  const remainingData = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('shopping-list-offline', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction('snapshot');
    const record = await new Promise((resolve, reject) => {
      const request = transaction.objectStore('snapshot').get('current-list');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    const appCaches = (await caches.keys()).filter((name) =>
      name.startsWith('shopping-list-shell-'),
    );
    return { hasSnapshot: record !== undefined, appCaches };
  });
  expect(remainingData).toEqual({ hasSnapshot: false, appCaches: [] });
});
