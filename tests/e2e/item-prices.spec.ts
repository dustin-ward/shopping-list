import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { featureOnOrigin } from './servers';

// The Prices sheet hangs off the Items screen and reads the same `/prices`
// endpoint ticket 20 built. This spec commits one real receipt through the UI,
// then proves the sheet's rows, its receipt link, its empty state and the add
// form's nudge all come from that committed data.
test.use({ baseURL: featureOnOrigin });
test.use({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });

const mutationHeaders = {
  origin: featureOnOrigin,
  'x-forwarded-proto': 'http',
  'content-type': 'application/json',
};

const imagePath = resolve(
  process.cwd(),
  'tests/fixtures/receipts/e2e-receipt.png',
);

/** A capture whose bytes are unique, so it is always the newest receipt. */
async function captureUnique(
  request: APIRequestContext,
  tag: string,
): Promise<void> {
  const response = await request.post('/api/receipts', {
    headers: { origin: featureOnOrigin, 'x-forwarded-proto': 'http' },
    multipart: {
      image: {
        name: 'receipt.png',
        mimeType: 'image/png',
        buffer: Buffer.concat([
          readFileSync(imagePath),
          Buffer.from(`\n#${tag}\n`),
        ]),
      },
    },
  });
  expect(response.status()).toBe(201);
}

/** Seed a catalog item without price history, the way the app does. */
async function seedItem(
  request: APIRequestContext,
  name: string,
): Promise<void> {
  const household = (await (await request.get('/api/snapshot')).json()) as {
    serverInstanceId: string;
  };
  const id = randomUUID();
  const added = await request.post('/api/entries', {
    headers: mutationHeaders,
    data: {
      serverInstanceId: household.serverInstanceId,
      id,
      name,
      quantityText: null,
      note: null,
      groupIds: [],
    },
  });
  expect(added.ok()).toBe(true);
  const purchased = await request.post(`/api/entries/${id}/purchase`, {
    headers: mutationHeaders,
    data: {
      serverInstanceId: household.serverInstanceId,
      expectedRevision: 1,
    },
  });
  expect(purchased.ok()).toBe(true);
}

async function openItems(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', { name: 'Items', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Items' })).toBeVisible();
}

async function openList(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', { name: 'List', exact: true }).click();
}

function lineRow(page: Page, parsedName: string) {
  return page.locator('.receipt-line', { hasText: parsedName });
}

test('prices sheet reads a committed receipt, links back to it, and nudges the add form', async ({
  page,
  request,
}) => {
  const suffix = randomUUID().slice(0, 8);
  const itemName = `Sourdough loaf ${suffix}`;
  const storeName = `Prices Market ${suffix}`;
  const emptyItem = `No receipts ${suffix}`;
  await seedItem(request, emptyItem);
  await captureUnique(request, `prices-sheet-${suffix}`);

  // Commit the fixture's bread line as a new item, with a quantity and a unit
  // filled in, so the sheet has a count family to draw instead of only a
  // spend amount.
  await page.goto('/');
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', { name: 'Receipts', exact: true }).click();
  await page.locator('.receipt-list .receipt-open').first().click();
  await expect(page.locator('.receipt-detail .status-chip')).toHaveText(
    'Review needed',
    { timeout: 15_000 },
  );

  const bread = lineRow(page, 'SOURDOUGH BREAD');
  // Reword the printed variant before committing. The shared e2e database is
  // reused across specs, and a commit learns the reviewed wording as an alias;
  // a unique phrase keeps this run's alias from tier-1-binding later receipts.
  const printedVariant = `PRICES LOAF ${suffix.toUpperCase()}`;
  await bread.getByLabel('Printed text').fill(printedVariant);
  await bread.getByLabel('Printed text').press('Enter');
  await bread.getByRole('button', { name: 'Create new item' }).click();
  await bread.getByLabel('New item name').fill(itemName);
  // A print of "2 @ 2.00" is what makes the line comparable at all.
  await bread.getByLabel('Quantity', { exact: true }).fill('2');
  await bread.getByLabel('Unit', { exact: true }).selectOption('ea');
  await bread.getByLabel('Unit price').fill('2.00');
  await bread.getByLabel('Unit price').press('Enter');
  for (const parsedName of ['MILK 2% 1L', 'GALA APPLES', 'CHEDDAR CHEESE']) {
    await lineRow(page, parsedName)
      .getByRole('button', { name: /can't identify/i })
      .click();
  }
  await page.getByRole('button', { name: 'Create new store' }).click();
  await page.getByLabel('New store name').fill(storeName);
  await page.getByRole('button', { name: 'Use new store' }).click();
  await page.getByRole('button', { name: 'Commit receipt' }).click();
  await expect(page.locator('.receipt-detail .status-chip')).toHaveText(
    'Committed',
    { timeout: 15_000 },
  );

  // The item detail is the Items screen's Prices action (ticket 19 left the
  // canonical-item surface there). The sheet reads the committed line.
  await openItems(page);
  const itemCard = page.locator('.item-card').filter({ hasText: itemName });
  await itemCard
    .getByRole('button', { name: `Prices for ${itemName}` })
    .click();

  const sheet = page.getByRole('dialog');
  await expect(
    sheet.getByRole('heading', { name: `Prices for ${itemName}` }),
  ).toBeVisible();
  const storeRow = sheet.locator('.price-store', { hasText: storeName });
  await expect(storeRow).toBeVisible();
  // SOURDOUGH BREAD 2 @ 2.00 committed today: last paid is the line total.
  await expect(storeRow.locator('.price-last-paid')).toContainText('4.99');
  await expect(storeRow.locator('.price-last-paid')).toContainText('today');
  await expect(storeRow.locator('.price-family-name')).toHaveText('Count');
  await expect(storeRow.locator('.price-unit')).toContainText('2.00');
  await expect(storeRow.locator('.price-unit')).toContainText('per ea');
  await expect(storeRow.locator('.price-trend')).toContainText(
    'Not enough history to trend',
  );
  // One point is a dot, not a fabricated line.
  await expect(storeRow.locator('.price-sparkline circle')).toHaveCount(1);
  await expect(storeRow.locator('.price-sparkline polyline')).toHaveCount(0);

  // The row links to the committed receipt that holds the price.
  await storeRow
    .getByRole('button', { name: `Open receipt from ${storeName}` })
    .click();
  await expect(page.locator('.receipt-detail .status-chip')).toHaveText(
    'Committed',
    { timeout: 15_000 },
  );

  // An item with no committed receipts says so instead of showing empty rows.
  await openItems(page);
  const emptyCard = page.locator('.item-card').filter({ hasText: emptyItem });
  await emptyCard
    .getByRole('button', { name: `Prices for ${emptyItem}` })
    .click();
  await expect(page.getByRole('dialog')).toContainText(
    'No committed receipts yet',
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The add form's nudge uses the same read: the household's own item name
  // resolves to a catalog item, whose newest committed price is quoted back.
  await openList(page);
  await page.getByRole('button', { name: 'Open add item form' }).click();
  // The add form resolves names against the page's snapshot, which catches up
  // on its own poll; wait for the commit's item to arrive before typing.
  await expect(
    page.locator(`#item-suggestions option[value="${itemName}"]`),
  ).toHaveCount(1, { timeout: 15_000 });
  await page.getByLabel('Item name').fill(itemName);
  const nudge = page.locator('.add-price-nudge');
  await expect(nudge).toContainText('4.99');
  await expect(nudge).toContainText(`today at ${storeName}`);
  await page.getByRole('button', { name: 'Close' }).click();
});
