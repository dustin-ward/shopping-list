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

// This spec drives the feature-enabled server (see playwright.config.ts).
test.use({ baseURL: featureOnOrigin });
test.use({
  // adapter-node derives the request protocol from `x-forwarded-proto` and
  // defaults to https, so over this plain-HTTP origin SvelteKit's CSRF check
  // rejects the multipart upload before any hook runs. A real deployment sits
  // behind Tailscale Serve over HTTPS (operations.md) and the proxy sets the
  // header; the browser has to add it here — the same accommodation the
  // API-level upload helper below makes by hand.
  extraHTTPHeaders: { 'x-forwarded-proto': 'http' },
});

/** Headers a JSON mutation from this spec needs: same origin, plain HTTP. */
const mutationHeaders = {
  origin: featureOnOrigin,
  'x-forwarded-proto': 'http',
  'content-type': 'application/json',
};

const image = readFileSync(
  resolve(process.cwd(), 'tests/fixtures/receipts/e2e-receipt.png'),
);

// A 32×64 JPEG tagged Orientation=6 (rotate 90° CW) with a GPS IFD. A correct
// capture must land as 64×32 with the EXIF block — GPS included — gone.
const taggedPhotoPath = resolve(
  process.cwd(),
  'tests/fixtures/receipts/capture-exif.jpg',
);

/** Open the app and land on the Receipts tab. */
async function openReceiptsTab(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', { name: 'Receipts', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Receipts' })).toBeVisible();
}

/**
 * How many receipts the server has for this list. The tab renders its own copy,
 * so counting here keeps assertions free of the list's load timing.
 */
async function receiptCount(request: APIRequestContext): Promise<number> {
  const response = await request.get('/api/receipts');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { items: unknown[] };
  return body.items.length;
}

/**
 * Upload one real PNG straight to the read API, the way the worker is fed. A
 * repeat upload of identical bytes dedupes to the existing receipt (200), so
 * both codes are success here.
 */
async function capture(request: APIRequestContext): Promise<string> {
  const response = await request.post('/api/receipts', {
    headers: { origin: featureOnOrigin, 'x-forwarded-proto': 'http' },
    multipart: {
      image: { name: 'receipt.png', mimeType: 'image/png', buffer: image },
    },
  });
  expect([200, 201]).toContain(response.status());
  const body = (await response.json()) as { id: string };
  return body.id;
}

/**
 * A capture whose bytes are unique, so it is always a fresh receipt and always
 * the newest one in the list. The extra trailing bytes do not change the PNG
 * signature the server validates.
 */
async function captureUnique(
  request: APIRequestContext,
  tag: string,
): Promise<string> {
  const response = await request.post('/api/receipts', {
    headers: { origin: featureOnOrigin, 'x-forwarded-proto': 'http' },
    multipart: {
      image: {
        name: 'receipt.png',
        mimeType: 'image/png',
        buffer: Buffer.concat([image, Buffer.from(`\n#${tag}\n`)]),
      },
    },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/** Open the newest receipt — the one this test just captured — in the editor. */
async function openNewestReceipt(page: Page): Promise<void> {
  await page.locator('.receipt-list .receipt-open').first().click();
  await expect(page.locator('.receipt-detail .status-chip')).toHaveText(
    'Review needed',
    { timeout: 15_000 },
  );
}

/** The household's own data, as the review editor's pickers read it. */
type HouseholdSnapshot = {
  serverInstanceId: string;
  catalogItems: { id: string; name: string }[];
  groups: { id: string; name: string }[];
};

async function readHousehold(
  request: APIRequestContext,
): Promise<HouseholdSnapshot> {
  const response = await request.get('/api/snapshot');
  expect(response.ok()).toBe(true);
  return (await response.json()) as HouseholdSnapshot;
}

/**
 * Seed a catalog item the way the app itself does — by adding a list entry —
 * then mark it purchased so the shared e2e list is left as the specs expect.
 * The catalog item stays, and it is what the review editor's search and the
 * matcher read.
 */
async function seedItem(
  request: APIRequestContext,
  name: string,
): Promise<void> {
  const { serverInstanceId } = await readHousehold(request);
  const id = randomUUID();
  const added = await request.post('/api/entries', {
    headers: mutationHeaders,
    data: {
      serverInstanceId,
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
    data: { serverInstanceId, expectedRevision: 1 },
  });
  expect(purchased.ok()).toBe(true);
}

/** Seed a store group, the way the Groups screen does. */
async function seedStore(
  request: APIRequestContext,
  name: string,
): Promise<void> {
  const { serverInstanceId } = await readHousehold(request);
  const response = await request.post('/api/groups', {
    headers: mutationHeaders,
    data: { serverInstanceId, name, kind: 'store' },
  });
  expect(response.ok()).toBe(true);
}

type StoredLine = {
  rawText: string;
  catalogItemId: string | null;
  reviewState: string;
  boundVia: string | null;
  boundRank: number | null;
};

/** One stored line of a receipt, read back through the detail API. */
async function storedLine(
  request: APIRequestContext,
  receiptId: string,
  rawText: string,
): Promise<StoredLine> {
  const response = await request.get(`/api/receipts/${receiptId}`);
  expect(response.ok()).toBe(true);
  const detail = (await response.json()) as { lines: StoredLine[] };
  const line = detail.lines.find((candidate) => candidate.rawText === rawText);
  expect(line, `no stored line for ${rawText}`).toBeDefined();
  return line!;
}

/**
 * One line's row, found by its parsed name. The parsed name is the parser's
 * output, so it identifies the row even after the reviewer edits the printed
 * text beside it.
 */
function lineRow(page: Page, parsedName: string) {
  return page.locator('.receipt-line', { hasText: parsedName });
}

test('captures a receipt, lists it, and flips pending to review in the open view', async ({
  page,
  request,
}) => {
  await capture(request);

  await page.goto('/');
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', { name: 'Receipts', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Receipts' })).toBeVisible();

  const card = page.locator('.receipt-list .receipt-open').first();
  await expect(card).toBeVisible();
  await card.click();

  await expect(
    page.getByRole('img', { name: 'Scanned receipt' }),
  ).toBeVisible();

  // Prove the detail view reaches `review` by polling, not by a reload: the
  // marker survives only while the document is not reloaded.
  await page.evaluate(() => {
    (window as unknown as { __receiptsNoReload?: boolean }).__receiptsNoReload =
      true;
  });
  await expect(page.locator('.receipt-detail .status-chip')).toHaveText(
    'Review needed',
    { timeout: 15_000 },
  );
  await expect(page.locator('.ocr-text')).toContainText('CORNER MARKET');
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __receiptsNoReload?: boolean })
          .__receiptsNoReload,
    ),
  ).toBe(true);
});

test('renders the parsed lines, the parked rows and the totals strip', async ({
  page,
  request,
}) => {
  // Every stub-mode capture parses the same committed fixture: 4 item rows
  // (MILK, SOURDOUGH BREAD, GALA APPLES, CHEDDAR CHEESE) and 9 parked rows.
  await capture(request);

  await openReceiptsTab(page);
  await page.locator('.receipt-list .receipt-open').first().click();
  await expect(page.locator('.receipt-detail .status-chip')).toHaveText(
    'Review needed',
    { timeout: 15_000 },
  );

  const rows = page.locator('.receipt-lines .receipt-line');
  await expect(rows).toHaveCount(13);
  // Parked rows stay on screen instead of being dropped.
  await expect(page.locator('.receipt-lines .receipt-line.parked')).toHaveCount(
    9,
  );
  const parked = page.locator('.receipt-line.parked', { hasText: 'SUBTOTAL' });
  await expect(parked.locator('.line-parked')).toHaveText('Parked');
  await expect(parked.locator('.line-total-price')).toContainText('17.55');

  const milk = page.locator('.receipt-line', { hasText: 'MILK 2% 1L' });
  // Item rows are the editor's forms now (ticket 11), so their printed text and
  // prices live in fields; the parsed name stays the parser's own output.
  await expect(milk.getByLabel('Printed text')).toHaveValue('MILK 2% 1L');
  await expect(milk.locator('.line-parsed-name')).toHaveText('MILK 2% 1L');
  await expect(milk.getByLabel('Line total')).toHaveValue('3.49');

  const strip = page.locator('.totals-strip');
  await expect(strip.locator('.totals-items')).toContainText('17.55');
  await expect(strip.locator('.totals-subtotal')).toContainText('17.55');
  await expect(strip.locator('.totals-tax')).toContainText('1.05');
  await expect(strip.locator('.totals-total')).toContainText('18.60');
  // These items add up to the subtotal, so the strip stays quiet.
  await expect(page.locator('.totals-warning')).toHaveCount(0);

  // The raw OCR text is still kept, below the parsed lines.
  await expect(page.locator('.ocr-text')).toContainText('CORNER MARKET');
});

test('serves the receipt image same-origin without caching', async ({
  request,
}) => {
  const id = await capture(request);

  const response = await request.get(`/api/receipts/${id}/image`);

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('image/png');
  expect(response.headers()['cache-control']).toBe('no-store');
});

test('captures through the file input: EXIF GPS stripped, orientation kept', async ({
  page,
  request,
}) => {
  // Guard the fixture: the tag really is in the bytes the client receives.
  expect(readFileSync(taggedPhotoPath).toString('latin1')).toContain(
    'EXIF-GPS-PRESENT',
  );

  await openReceiptsTab(page);
  const cards = page.locator('.receipt-list .receipt-card');
  const before = await receiptCount(request);

  await page.locator('input[type="file"]').setInputFiles(taggedPhotoPath);
  await expect(page.locator('.capture-notice')).toContainText(
    'Receipt captured',
    { timeout: 15_000 },
  );
  await expect(cards).toHaveCount(before + 1);

  // The newest receipt is the capture; its stored image must be the client's
  // re-encode, not the camera original.
  await cards.first().locator('button').click();
  await expect(
    page.getByRole('img', { name: 'Scanned receipt' }),
  ).toBeVisible();
  const src = await page.locator('.receipt-image img').getAttribute('src');
  expect(src).toMatch(/^\/api\/receipts\/[0-9a-f-]+\/image$/u);

  const stored = await page.evaluate(async (url) => {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const bitmap = await createImageBitmap(new Blob([bytes]));
    const { width, height } = bitmap;
    bitmap.close();
    return {
      width,
      height,
      text: new TextDecoder('latin1').decode(bytes),
    };
  }, src ?? '');

  // Orientation 6 turns the portrait original (32×64) into landscape.
  expect(stored.width).toBe(64);
  expect(stored.height).toBe(32);
  expect(stored.text).not.toContain('Exif');
  expect(stored.text).not.toContain('EXIF-GPS-PRESENT');
});

test('reports the same photo a second time as already captured', async ({
  page,
  request,
}) => {
  await openReceiptsTab(page);

  // The capture test above may already have sent this fixture, so the first
  // upload is allowed to be a fresh capture or a duplicate.
  await page.locator('input[type="file"]').setInputFiles(taggedPhotoPath);
  await expect(page.locator('.capture-notice')).toContainText(
    /Receipt captured|already captured/,
    { timeout: 15_000 },
  );
  const afterFirst = await receiptCount(request);

  // Identical bytes dedupe server-side instead of creating a second receipt.
  await page.locator('input[type="file"]').setInputFiles(taggedPhotoPath);
  await expect(page.locator('.capture-notice')).toContainText(
    'already captured',
    { timeout: 15_000 },
  );
  expect(await receiptCount(request)).toBe(afterFirst);
});

test('rejects a file that is not a photo before uploading it', async ({
  page,
  request,
}) => {
  await openReceiptsTab(page);
  const before = await receiptCount(request);

  await page.locator('input[type="file"]').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('definitely not a receipt photo'),
  });

  await expect(page.locator('.capture-error')).toContainText("isn't a photo");
  expect(await receiptCount(request)).toBe(before);
});

test('hides capture while the device is offline', async ({ page }) => {
  await openReceiptsTab(page);
  const captureButton = page.getByRole('button', {
    name: 'Capture receipt',
    exact: true,
  });
  await expect(captureButton).toBeVisible();

  await page.context().setOffline(true);
  // The snapshot poll notices the dropped connection (canWrite → false).
  await expect(captureButton).toHaveCount(0, { timeout: 15_000 });

  await page.context().setOffline(false);
});

test('reviews a receipt: unknown and skipped states survive a reload', async ({
  page,
  request,
}) => {
  await captureUnique(request, 'states');
  await openReceiptsTab(page);
  await openNewestReceipt(page);

  const milk = lineRow(page, 'MILK 2% 1L');
  await expect(milk.locator('.line-state')).toHaveText('Unreviewed');

  await milk.getByRole('button', { name: /can't identify/i }).click();
  await expect(milk.locator('.line-state')).toHaveText('Unknown');

  const bread = lineRow(page, 'SOURDOUGH BREAD');
  await bread.getByRole('button', { name: 'Skip' }).click();
  await expect(bread.locator('.line-state')).toHaveText('Skipped');

  // The control toggles: pressing the state again releases the line back to a
  // decision still to make, and the "can't identify" choice is not sticky.
  await milk.getByRole('button', { name: /can't identify/i }).click();
  await expect(milk.locator('.line-state')).toHaveText('Unreviewed');

  await page.reload();
  await openReceiptsTab(page);
  await openNewestReceipt(page);

  await expect(
    lineRow(page, 'SOURDOUGH BREAD').locator('.line-state'),
  ).toHaveText('Skipped');
  await expect(lineRow(page, 'MILK 2% 1L').locator('.line-state')).toHaveText(
    'Unreviewed',
  );
});

test('edits a line: the strip follows, and the edit survives a reload', async ({
  page,
  request,
}) => {
  await captureUnique(request, 'edits');
  await openReceiptsTab(page);
  await openNewestReceipt(page);

  const strip = page.locator('.totals-strip');
  await expect(strip.locator('.totals-items')).toContainText('17.55');

  const milk = lineRow(page, 'MILK 2% 1L');
  await milk.getByLabel('Line total').fill('4.00');
  // Enter commits the row's form (a blur does the same for a mouse user).
  await milk.getByLabel('Line total').press('Enter');
  await expect(strip.locator('.totals-items')).toContainText('18.06');
  // The edited sum no longer reconciles, and the strip says so.
  await expect(strip.locator('.totals-warning')).toContainText('18.06');

  await milk.getByLabel('Printed text').fill('MILK 2% 2L');
  await milk.getByLabel('Printed text').press('Enter');
  await expect(milk.getByLabel('Printed text')).toHaveValue('MILK 2% 2L');

  await page.reload();
  await openReceiptsTab(page);
  await openNewestReceipt(page);

  const reread = lineRow(page, 'MILK 2% 1L');
  await expect(reread.getByLabel('Printed text')).toHaveValue('MILK 2% 2L');
  await expect(reread.getByLabel('Line total')).toHaveValue('4.00');
  await expect(page.locator('.totals-strip .totals-items')).toContainText(
    '18.06',
  );
  // The engine's output is the immutable original: edits correct the reviewed
  // text without rewriting what was read.
  await expect(page.locator('.ocr-text')).toContainText('MILK 2% 1L');
});

test('the has-unknowns chip lists only receipts with unknown lines', async ({
  page,
  request,
}) => {
  await captureUnique(request, 'unknowns');
  await openReceiptsTab(page);
  await openNewestReceipt(page);

  const milk = lineRow(page, 'MILK 2% 1L');
  await milk.getByRole('button', { name: /can't identify/i }).click();
  await expect(milk.locator('.line-state')).toHaveText('Unknown');

  await page.getByRole('button', { name: 'Back to receipts' }).click();
  const cards = page.locator('.receipt-list .receipt-card');
  await expect(cards.first()).toBeVisible();

  const filtered = (await (
    await request.get('/api/receipts?hasUnknowns=true')
  ).json()) as { items: unknown[] };
  expect(filtered.items.length).toBeGreaterThan(0);

  const unknownChip = page.getByRole('button', {
    name: 'Has unknowns',
    exact: true,
  });
  await unknownChip.click();
  await expect(cards).toHaveCount(filtered.items.length);
  // Every card left on screen is a receipt that has one, badge and all.
  await expect(page.locator('.receipt-list .unknown-badge')).toHaveCount(
    filtered.items.length,
  );

  // Releasing the chip brings the whole list back.
  await unknownChip.click();
  const all = (await (await request.get('/api/receipts')).json()) as {
    items: unknown[];
  };
  expect(all.items.length).toBeGreaterThan(filtered.items.length);
  await expect(cards).toHaveCount(all.items.length);
});

test('browses unknown lines by wording and binds a whole group to an item', async ({
  page,
  request,
}) => {
  // A phrase unique to this run: the unknown browser groups across the whole
  // list, so a fixed wording could carry lines from earlier runs.
  const suffix = randomUUID().slice(0, 8);
  const phrase = `MYSTERY ${suffix.toUpperCase()}`;
  const itemName = `Mystery item ${suffix}`;
  const storeName = `Harbor Market ${suffix}`;
  await seedItem(request, itemName);
  await seedStore(request, storeName);
  const receiptId = await captureUnique(request, `unknown-browser-${suffix}`);

  await openReceiptsTab(page);
  await openNewestReceipt(page);

  // The fixture's milk row is reworded to this run's phrase, then left unknown —
  // exactly the observation a reviewer commits without an item.
  const milk = lineRow(page, 'MILK 2% 1L');
  await milk.getByLabel('Printed text').fill(phrase);
  await milk.getByLabel('Printed text').press('Enter');
  await milk.getByRole('button', { name: /can't identify/i }).click();
  await expect(milk.locator('.line-state')).toHaveText('Unknown');
  for (const parsedName of [
    'SOURDOUGH BREAD',
    'GALA APPLES',
    'CHEDDAR CHEESE',
  ]) {
    await lineRow(page, parsedName)
      .getByRole('button', { name: /can't identify/i })
      .click();
  }
  await page.locator('.store-select').selectOption({ label: storeName });
  await page.getByRole('button', { name: 'Commit receipt' }).click();
  await expect(page.locator('.receipt-detail .status-chip')).toHaveText(
    'Committed',
    { timeout: 15_000 },
  );

  // The grouped browser reads committed receipts only, and doubles as the
  // unidentified-spending view.
  await page.getByRole('button', { name: 'Back to receipts' }).click();
  await page.getByRole('button', { name: 'Unknowns', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Unknown lines' }),
  ).toBeVisible();
  await expect(page.locator('.unknown-total')).toContainText('unidentified');

  const group = page.locator('.unknown-group', { hasText: phrase });
  await expect(group.locator('.unknown-text')).toHaveText(phrase);
  await expect(group.locator('.unknown-count')).toHaveText('1 line');
  await expect(group.locator('.unknown-spend')).toContainText('3.49');

  // Choosing an item only asks — one tap must not move every line printing the
  // wording.
  await group.getByLabel(`Find item for ${phrase}`).fill(itemName);
  await group.locator('.unknown-match', { hasText: itemName }).click();
  await expect(group.locator('.unknown-question')).toContainText(
    `Bind 1 line to ${itemName}`,
  );
  await expect(group.locator('.unknown-question')).toContainText(
    'Matching will learn',
  );
  await group.getByRole('button', { name: 'Bind 1 line' }).click();

  await expect(page.locator('.unknown-notice')).toContainText(
    'Matching will learn',
  );
  // The group is gone from the unidentified-spending view.
  await expect(page.locator('.unknown-group', { hasText: phrase })).toHaveCount(
    0,
  );

  // Every constituent line carries the pick with a manual provenance…
  const household = await readHousehold(request);
  const itemId = household.catalogItems.find(
    (item) => item.name === itemName,
  )?.id;
  expect(itemId).toBeDefined();
  expect(await storedLine(request, receiptId, phrase)).toMatchObject({
    reviewState: 'bound',
    catalogItemId: itemId,
    boundVia: 'manual',
    boundRank: null,
  });

  // …and the wording is a live alias, so the next receipt printing it binds by
  // itself (the integration tests exercise that rebind end to end).
  const aliases = (await (await request.get('/api/aliases')).json()) as {
    items: {
      name: string;
      aliases: { aliasText: string; deletedAt: string | null }[];
    }[];
  };
  expect(
    aliases.items
      .find((item) => item.name === itemName)
      ?.aliases.find((alias) => alias.aliasText === phrase)?.deletedAt,
  ).toBeNull();
});

test('binds a suggestion and drafts an item and a store without creating rows', async ({
  page,
  request,
}) => {
  // The household already knows "Milk" (a fuzzy match for the fixture's
  // "MILK 2% 1L" — no alias exists until a commit learns one) and "Corner
  // Market", the store printed in the fixture's header.
  await seedItem(request, 'Milk');
  await seedStore(request, 'Corner Market');
  const receiptId = await captureUnique(request, 'binding');

  await openReceiptsTab(page);
  await openNewestReceipt(page);

  // The store picker shows its required state and the best match it read from
  // the receipt's own text; one tap confirms it.
  await expect(page.locator('.store-required')).toContainText(
    'Store required before commit.',
  );
  await expect(page.locator('.store-prefill')).toContainText('Corner Market');
  await page.getByRole('button', { name: 'Use Corner Market' }).click();
  await expect(page.locator('.store-required')).toHaveCount(0);
  await expect(page.locator('.store-select')).toHaveValue(/[0-9a-f-]{36}/u);

  // The top candidate is prefilled in the item picker (plan §7) — prefigured,
  // never bound on its own.
  const milk = lineRow(page, 'MILK 2% 1L');
  await expect(milk.getByLabel('Find item')).toHaveValue('Milk');
  await expect(milk.locator('.line-state')).toHaveText('Unreviewed');

  // Accepting the tier-2 chip binds the line and records the accepted rank.
  const chip = milk.locator('button.suggestion-button', { hasText: 'Milk' });
  await expect(chip).toContainText('Tier 2');
  await chip.click();
  await expect(milk.locator('.line-state')).toHaveText('Bound');
  await expect(milk.locator('.binding-item')).toHaveText('Milk');
  await expect(
    await storedLine(request, receiptId, 'MILK 2% 1L'),
  ).toMatchObject({
    reviewState: 'bound',
    boundVia: 'suggested',
    boundRank: 1,
  });

  // Rejecting the chip the line sits on leaves it unbound — no item, no
  // provenance, back to a decision still to make.
  await chip.click();
  await expect(milk.locator('.line-state')).toHaveText('Unreviewed');
  await expect(
    await storedLine(request, receiptId, 'MILK 2% 1L'),
  ).toMatchObject({
    reviewState: 'unreviewed',
    catalogItemId: null,
    boundVia: null,
    boundRank: null,
  });

  // Confirming the prefill from the search is the tier-3 path — the reviewer
  // found the item there, so the bind is manual and carries no rank.
  await milk.locator('.item-matches button.match-button').click();
  await expect(milk.locator('.line-state')).toHaveText('Bound');
  await expect(milk.locator('.binding-item')).toHaveText('Milk');
  await expect(
    await storedLine(request, receiptId, 'MILK 2% 1L'),
  ).toMatchObject({
    reviewState: 'bound',
    boundVia: 'manual',
    boundRank: null,
  });

  // An inline-created item is a draft: the line leaves `unreviewed`, and the
  // reviewer's name lives in the editor. It starts from the parser's name, not
  // from a search — which is why the reviewer renames it.
  const bread = lineRow(page, 'SOURDOUGH BREAD');
  await bread.getByRole('button', { name: 'Create new item' }).click();
  await expect(bread.locator('.line-state')).toHaveText('New item');
  await expect(bread.getByLabel('New item name')).toHaveValue(
    'SOURDOUGH BREAD',
  );
  await bread.getByLabel('New item name').fill('Sourdough loaf');
  await expect(bread.getByLabel('New item name')).toHaveValue('Sourdough loaf');

  // The same for a new store: it stands in as the chosen store, and the picker
  // stops asking for one. Drafting a store takes the place of the group that
  // was chosen a moment ago — one of the two can stand, never both.
  await page.getByRole('button', { name: 'Create new store' }).click();
  await page.getByLabel('New store name').fill('Trader Joe’s');
  await page.getByRole('button', { name: 'Use new store' }).click();
  await expect(page.locator('.store-required')).toHaveCount(0);
  await expect(page.locator('.store-select')).toHaveValue('__draft_store__');
  await expect(page.locator('.store-select')).toContainText(
    'New store: Trader Joe’s (draft)',
  );
  const afterDraft = (await (
    await request.get(`/api/receipts/${receiptId}`)
  ).json()) as { storeGroupId: string | null };
  expect(afterDraft.storeGroupId).toBeNull();

  // Neither draft is an entity yet: commit (ticket 13) is what creates rows.
  const household = await readHousehold(request);
  expect(household.catalogItems.map((item) => item.name)).not.toContain(
    'Sourdough loaf',
  );
  expect(household.groups.map((group) => group.name)).not.toContain(
    'Trader Joe’s',
  );
});

test('commits a reviewed receipt: the drafts become rows and the view goes read-only', async ({
  page,
  request,
}) => {
  // Names unique to this run, so "the item exists" can only mean the commit
  // created it — a fixed name could be a leftover from an earlier run.
  const suffix = randomUUID().slice(0, 8);
  const itemName = `Sourdough loaf ${suffix}`;
  const storeName = `Harbor Market ${suffix}`;
  const receiptId = await captureUnique(request, `commit-${suffix}`);

  await openReceiptsTab(page);
  await openNewestReceipt(page);

  // The gate: every item line is still undecided, so commit is refused and the
  // button says what is missing.
  const commitButton = page.getByRole('button', { name: 'Commit receipt' });
  await expect(commitButton).toBeDisabled();
  await expect(page.locator('.commit-blocker')).toContainText('item line');

  // One line drafts a new item…
  const bread = lineRow(page, 'SOURDOUGH BREAD');
  await bread.getByRole('button', { name: 'Create new item' }).click();
  await bread.getByLabel('New item name').fill(itemName);

  // …and the rest are decided without one: two unknowns and a skip.
  await lineRow(page, 'MILK 2% 1L')
    .getByRole('button', { name: /can't identify/i })
    .click();
  await lineRow(page, 'GALA APPLES')
    .getByRole('button', { name: /can't identify/i })
    .click();
  await lineRow(page, 'CHEDDAR CHEESE')
    .getByRole('button', { name: 'Skip' })
    .click();

  // Every item line is decided now; the store is what is missing.
  await expect(page.locator('.commit-blocker')).toContainText('store');
  await expect(commitButton).toBeDisabled();

  // A drafted store stands in for one, and the gate opens.
  await page.getByRole('button', { name: 'Create new store' }).click();
  await page.getByLabel('New store name').fill(storeName);
  await page.getByRole('button', { name: 'Use new store' }).click();
  await expect(page.locator('.commit-blocker')).toHaveCount(0);
  await expect(commitButton).toBeEnabled();

  await commitButton.click();

  // The receipt is committed, and the editor is read-only from here on.
  await expect(page.locator('.receipt-detail .status-chip')).toHaveText(
    'Committed',
    { timeout: 15_000 },
  );
  await expect(page.locator('.receipt-lines input.line-printed')).toHaveCount(
    0,
  );
  await expect(commitButton).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Discard receipt' }),
  ).toHaveCount(0);

  // The drafted item is a catalog row, and the line still carries the state the
  // reviewer left it in — with the provenance of the commit's own creation.
  const stored = await storedLine(request, receiptId, 'SOURDOUGH BREAD');
  expect(stored).toMatchObject({
    reviewState: 'new',
    boundVia: 'created',
  });
  expect(stored.catalogItemId).not.toBeNull();

  const household = await readHousehold(request);
  expect(household.catalogItems.map((item) => item.name)).toContain(itemName);
  expect(household.groups.map((group) => group.name)).toContain(storeName);

  // The read-only row shows the item it landed on. That name comes from the
  // snapshot the page polls — it is only there because the commit created a
  // snapshot-visible row and bumped the revision — and no reload happens here.
  await expect(
    lineRow(page, 'SOURDOUGH BREAD').locator('.line-bound-item'),
  ).toHaveText(itemName, { timeout: 15_000 });
  // An unknown line stays an observation: no item, no name, still shown.
  await expect(
    lineRow(page, 'GALA APPLES').locator('.line-bound-item'),
  ).toHaveCount(0);

  // A second commit is a conflict, not a re-run.
  const detail = (await (
    await request.get(`/api/receipts/${receiptId}`)
  ).json()) as { updatedAt: string };
  const again = await request.post(`/api/receipts/${receiptId}/commit`, {
    headers: mutationHeaders,
    data: { expectedUpdatedAt: detail.updatedAt },
  });
  expect(again.status()).toBe(409);
  expect(((await again.json()) as { error: { code: string } }).error.code).toBe(
    'RECEIPT_ALREADY_COMMITTED',
  );

  // The list around the detail was refreshed too: the row reads Committed.
  await page.getByRole('button', { name: 'Back to receipts' }).click();
  await expect(
    page.locator('.receipt-list .receipt-card').first().locator('.status-chip'),
  ).toHaveText('Committed');
});

test('reads matching stats: provenance shares, reconciliation and accepted ranks', async ({
  page,
  request,
}) => {
  // Names unique to this run: the stats view is a read over the whole committed
  // corpus, so the test proves its own commit is in it rather than expecting an
  // exact total a reused database could not promise.
  const suffix = randomUUID().slice(0, 8);
  const itemName = `Stats milk ${suffix}`;
  const storeName = `Stats Market ${suffix}`;
  await seedItem(request, itemName);
  await seedStore(request, storeName);

  // Commit one review whose provenance is known: one manual bind and three
  // unknown lines (the parked rows never count). The bind learns an alias from
  // the reviewed printed text, so the text is made unique to this run — a
  // generic wording would auto-bind the alias tests' later receipts.
  await captureUnique(request, `stats-${suffix}`);
  await openReceiptsTab(page);
  await openNewestReceipt(page);
  const milk = lineRow(page, 'MILK 2% 1L');
  const printedText = `STATS MILK ${suffix}`;
  await milk.getByLabel('Printed text').fill(printedText);
  await milk.getByLabel('Printed text').press('Enter');
  await expect(milk.getByLabel('Printed text')).toHaveValue(printedText);
  await milk.getByLabel('Find item').fill(itemName);
  await milk
    .locator('.item-matches button.match-button', { hasText: itemName })
    .click();
  for (const parsedName of [
    'SOURDOUGH BREAD',
    'GALA APPLES',
    'CHEDDAR CHEESE',
  ]) {
    await lineRow(page, parsedName)
      .getByRole('button', { name: /can't identify/i })
      .click();
  }
  await page.locator('.store-select').selectOption({ label: storeName });
  await page.getByRole('button', { name: 'Commit receipt' }).click();
  await expect(page.locator('.receipt-detail .status-chip')).toHaveText(
    'Committed',
    { timeout: 15_000 },
  );

  // The surface is a read-only view of the tab, reached from its secondary
  // actions; nothing on it writes.
  await page.getByRole('button', { name: 'Back to receipts' }).click();
  await page.getByRole('button', { name: 'Matching stats' }).click();
  await expect(
    page.getByRole('heading', { name: 'Matching stats' }),
  ).toBeVisible();

  // Every provenance bucket is named, and this run's commit is visible in the
  // manual and no-binding rows.
  for (const label of [
    'Automatic (tier 1)',
    'Accepted suggestion (tier 2)',
    'Chosen manually',
    'Item created in review',
    'Unknown or skipped',
  ]) {
    await expect(page.locator('.stats-sources')).toContainText(label);
  }
  const manualCount = Number(
    await page
      .locator('[data-source="manual"] .stats-source-count')
      .textContent(),
  );
  const noBindingCount = Number(
    await page
      .locator('[data-source="no-binding"] .stats-source-count')
      .textContent(),
  );
  expect(manualCount).toBeGreaterThanOrEqual(1);
  expect(noBindingCount).toBeGreaterThanOrEqual(3);

  // The reconciliation is on screen, and the rank section answers even when no
  // suggestion has been accepted yet.
  await expect(page.locator('.stats-reconciliation')).toContainText(
    'committed item lines:',
  );
  await expect(page.getByText('Accepted suggestions by rank')).toBeVisible();
  await expect(page.locator('.stats-rank-summary')).toContainText(
    /accepted suggestion|No accepted suggestions/,
  );

  await page.getByRole('button', { name: 'Back to receipts' }).click();
  await expect(page.getByRole('heading', { name: 'Receipts' })).toBeVisible();
});

test('manages learned aliases: a delete stops auto-binding, the next review relearns it', async ({
  page,
  request,
}) => {
  // A name unique to this run: aliases are per list and the e2e server is
  // reused between local runs, so leftovers must not be able to satisfy an
  // assertion about *this* item.
  const suffix = randomUUID().slice(0, 8);
  const itemName = `Milk ${suffix}`;
  const storeName = `Harbor Market ${suffix}`;
  await seedItem(request, itemName);
  await seedStore(request, storeName);

  /** Decide every item line of the stub fixture and choose the store. */
  async function decideFixture(receiptPage: Page): Promise<void> {
    const milk = lineRow(receiptPage, 'MILK 2% 1L');
    await milk.getByLabel('Find item').fill(itemName);
    await milk
      .locator('.item-matches button.match-button', { hasText: itemName })
      .click();
    await expect(milk.locator('.line-state')).toHaveText('Bound');
    for (const parsedName of [
      'SOURDOUGH BREAD',
      'GALA APPLES',
      'CHEDDAR CHEESE',
    ]) {
      const row = lineRow(receiptPage, parsedName);
      await row.getByRole('button', { name: /can't identify/i }).click();
      await expect(row.locator('.line-state')).toHaveText('Unknown');
    }
    await receiptPage
      .locator('.store-select')
      .selectOption({ label: storeName });
  }

  async function commit(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Commit receipt' }).click();
    await expect(page.locator('.receipt-detail .status-chip')).toHaveText(
      'Committed',
      { timeout: 15_000 },
    );
  }

  // 1. Commit one review of the fixture: the printed text the milk line was
  //    bound to is learned as an alias for the item.
  await captureUnique(request, `alias-learn-${suffix}`);
  await openReceiptsTab(page);
  await openNewestReceipt(page);
  await decideFixture(page);
  await commit(page);

  // 2. The alias is visible under its item in the alias view.
  await page.getByRole('button', { name: 'Back to receipts' }).click();
  await page.getByRole('button', { name: 'Aliases', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Aliases' })).toBeVisible();
  const milkItem = page.locator('.alias-item', { hasText: itemName });
  await expect(milkItem.locator('.alias-text')).toHaveText('MILK 2% 1L');
  await expect(milkItem.locator('.alias-source')).toHaveText(
    'Learned in review',
  );

  // 3. Deleting asks twice; the row then leaves the live list and stays
  //    queryable behind the audit toggle.
  await milkItem
    .getByRole('button', { name: 'Delete alias MILK 2% 1L' })
    .click();
  await expect(milkItem.locator('.alias-confirm')).toContainText(
    'kept for audit',
  );
  await milkItem.getByRole('button', { name: 'Cancel' }).click();
  await expect(milkItem.locator('.alias-confirm')).toHaveCount(0);

  await milkItem
    .getByRole('button', { name: 'Delete alias MILK 2% 1L' })
    .click();
  await milkItem.getByRole('button', { name: 'Delete alias' }).click();
  await expect(page.locator('.alias-notice')).toContainText(
    'will no longer auto-bind',
  );
  await expect(milkItem.locator('.alias-text')).toHaveCount(0);

  await page.getByRole('button', { name: /Show deleted aliases/ }).click();
  await expect(milkItem.locator('.alias-text')).toHaveText('MILK 2% 1L');
  await expect(milkItem.locator('.alias-row')).toHaveClass(/deleted/);
  await expect(milkItem.locator('.alias-deleted')).toHaveText('Kept for audit');

  // 4. The next receipt no longer auto-binds that wording: the line is left for
  //    the reviewer, which is exactly what the delete bought. The capture went
  //    straight to the API, so the tab is reopened to read the list that holds
  //    it — the same full load `openReceiptsTab` gives every test.
  const second = await captureUnique(request, `alias-relearn-${suffix}`);
  await openReceiptsTab(page);
  await openNewestReceipt(page);
  await expect(lineRow(page, 'MILK 2% 1L').locator('.line-state')).toHaveText(
    'Unreviewed',
  );
  expect(await storedLine(request, second, 'MILK 2% 1L')).toMatchObject({
    catalogItemId: null,
    reviewState: 'unreviewed',
    boundVia: null,
  });

  // 5. Reviewing it again and committing relearns the same row…
  await decideFixture(page);
  await commit(page);

  await page.getByRole('button', { name: 'Back to receipts' }).click();
  await page.getByRole('button', { name: 'Aliases', exact: true }).click();
  await expect(
    page.locator('.alias-item', { hasText: itemName }).locator('.alias-text'),
  ).toHaveText('MILK 2% 1L');
  await expect(
    page.locator('.alias-item', { hasText: itemName }).locator('.alias-row'),
  ).not.toHaveClass(/deleted/);

  // 6. …and the receipt after that binds by itself, with no tap at all.
  const third = await captureUnique(request, `alias-auto-${suffix}`);
  await openReceiptsTab(page);
  await openNewestReceipt(page);
  const bound = lineRow(page, 'MILK 2% 1L');
  await expect(bound.locator('.line-state')).toHaveText('Bound');
  await expect(bound.locator('.binding-item')).toHaveText(itemName);
  expect(await storedLine(request, third, 'MILK 2% 1L')).toMatchObject({
    reviewState: 'bound',
    boundVia: 'auto',
  });
});

test('repairs a committed binding: explicit mode, alias moves, raw artifacts stay', async ({
  page,
  request,
}) => {
  // Names unique to this run: aliases are per list and the e2e server is reused
  // between local runs, so leftovers must not satisfy an assertion about this one.
  const suffix = randomUUID().slice(0, 8);
  const milkName = `Milk ${suffix}`;
  const ryeName = `Rye loaf ${suffix}`;
  const storeName = `Harbor Market ${suffix}`;
  await seedItem(request, milkName);
  await seedItem(request, ryeName);
  await seedStore(request, storeName);

  /** Decide the fixture and commit it, leaving MILK bound to `milkName`. */
  async function reviewAndCommit(receiptPage: Page): Promise<void> {
    const milk = lineRow(receiptPage, 'MILK 2% 1L');
    // An earlier spec can leave a live alias for this printed wording, which
    // auto-binds the line before the reviewer sees it; releasing it is how the
    // reviewer would take it back.
    const release = milk.getByRole('button', { name: 'Release' });
    if (await release.count()) await release.click();
    await milk.getByLabel('Find item').fill(milkName);
    await milk
      .locator('.item-matches button.match-button', { hasText: milkName })
      .click();
    await expect(milk.locator('.line-state')).toHaveText('Bound');
    for (const parsedName of [
      'SOURDOUGH BREAD',
      'GALA APPLES',
      'CHEDDAR CHEESE',
    ]) {
      const row = lineRow(receiptPage, parsedName);
      await row.getByRole('button', { name: /can't identify/i }).click();
    }
    await receiptPage
      .locator('.store-select')
      .selectOption({ label: storeName });
    await receiptPage.getByRole('button', { name: 'Commit receipt' }).click();
    await expect(
      receiptPage.locator('.receipt-detail .status-chip'),
    ).toHaveText('Committed', { timeout: 15_000 });
  }

  const receiptId = await captureUnique(request, `repair-${suffix}`);
  await openReceiptsTab(page);
  await openNewestReceipt(page);
  await reviewAndCommit(page);

  const milk = lineRow(page, 'MILK 2% 1L');
  const repaired = await storedLine(request, receiptId, 'MILK 2% 1L');
  expect(repaired).toMatchObject({ reviewState: 'bound', boundVia: 'manual' });

  // A committed receipt offers repair, but nothing is in repair mode yet, and
  // the printed text is not editable.
  const repairRow = page.locator('.repair-row');
  await expect(page.locator('.receipt-lines input.line-printed')).toHaveCount(
    0,
  );
  await repairRow.getByRole('button', { name: 'Repair binding' }).click();
  await expect(page.locator('.repair-confirm')).toContainText(
    'aliases follow the fix',
  );
  await expect(page.locator('.receipt-line.repairing')).toHaveCount(0);

  // Cancelling leaves everything untouched: still no repair controls, still the
  // binding the commit left behind.
  await repairRow.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.repair-confirm')).toHaveCount(0);
  await expect(page.locator('.receipt-line.repairing')).toHaveCount(0);
  await expect(milk.locator('.line-bound-item')).toHaveText(milkName);

  // Entering the mode is the explicit second tap.
  await repairRow.getByRole('button', { name: 'Repair binding' }).click();
  await repairRow.getByRole('button', { name: 'Start repair' }).click();
  await expect(page.locator('.repair-banner')).toContainText(
    'photo stay as committed',
  );
  await expect(milk).toHaveClass(/repairing/);
  // The raw artifacts are frozen even here.
  await expect(page.locator('.receipt-lines input.line-printed')).toHaveCount(
    0,
  );

  // Re-bind the line to the other item through the repair search.
  await milk.getByLabel('Find item').fill(ryeName);
  await milk
    .locator('.item-matches button.match-button', { hasText: ryeName })
    .click();
  await expect(milk.locator('.line-bound-item')).toHaveText(ryeName, {
    timeout: 15_000,
  });

  const household = await readHousehold(request);
  const ryeId = household.catalogItems.find(
    (item) => item.name === ryeName,
  )?.id;
  expect(ryeId).toBeDefined();
  expect(await storedLine(request, receiptId, 'MILK 2% 1L')).toMatchObject({
    catalogItemId: ryeId,
    reviewState: 'bound',
    boundVia: 'manual',
  });

  // The correction leaves the mode, and the raw receipt is otherwise untouched.
  await repairRow.getByRole('button', { name: 'Done repairing' }).click();
  await expect(page.locator('.repair-banner')).toHaveCount(0);
  await expect(page.locator('.receipt-line.repairing')).toHaveCount(0);
  await expect(page.locator('.receipt-detail .status-chip')).toHaveText(
    'Committed',
  );
  await expect(milk.locator('.line-printed')).toHaveText('MILK 2% 1L');
  await expect(page.locator('.ocr-text')).toContainText('MILK 2% 1L');
  await expect(page.locator('.receipt-image img')).toHaveCount(1);
  const after = (await (
    await request.get(`/api/receipts/${receiptId}`)
  ).json()) as { imageAvailable: boolean; ocrText: string | null };
  expect(after.imageAvailable).toBe(true);
  expect(after.ocrText).toContain('MILK 2% 1L');

  // The alias state followed the repair: the wording this line taught for the
  // wrong item no longer binds, and the corrected item now claims it.
  const overview = (await (await request.get('/api/aliases')).json()) as {
    items: {
      name: string;
      aliases: { aliasText: string; deletedAt: string | null }[];
    }[];
  };
  const liveAlias = (name: string) =>
    overview.items
      .find((item) => item.name === name)
      ?.aliases.find(
        (alias) => alias.aliasText === 'MILK 2% 1L' && alias.deletedAt === null,
      );

  expect(liveAlias(ryeName)).toBeDefined();
  expect(liveAlias(milkName)).toBeUndefined();
});

test('discards a receipt: the photo goes, the text stays, the bytes capture again', async ({
  page,
  request,
}) => {
  const tag = `discard-${randomUUID().slice(0, 8)}`;
  const receiptId = await captureUnique(request, tag);
  const before = await receiptCount(request);

  await openReceiptsTab(page);
  await openNewestReceipt(page);
  await expect(page.locator('.receipt-lines .receipt-line')).toHaveCount(13);

  // One tap only asks: the receipt is untouched until the confirm.
  await page.getByRole('button', { name: 'Discard receipt' }).click();
  await expect(page.locator('.discard-confirm')).toContainText(
    'text and lines are kept',
  );
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.discard-confirm')).toHaveCount(0);
  await expect(page.locator('.receipt-detail .status-chip')).toHaveText(
    'Review needed',
  );

  await page.getByRole('button', { name: 'Discard receipt' }).click();
  await page.getByRole('button', { name: 'Confirm discard' }).click();

  // Discarded, purged, and still readable: the audit trail is the text.
  await expect(page.locator('.receipt-detail .status-chip')).toHaveText(
    'Discarded',
    { timeout: 15_000 },
  );
  await expect(page.locator('.purged-note')).toContainText('Image purged');
  await expect(page.locator('.receipt-lines .receipt-line')).toHaveCount(13);
  await expect(page.locator('.ocr-text')).toContainText('MILK 2% 1L');
  await expect(
    page.getByRole('button', { name: 'Discard receipt' }),
  ).toHaveCount(0);

  const detail = (await (
    await request.get(`/api/receipts/${receiptId}`)
  ).json()) as { status: string; imageAvailable: boolean };
  expect(detail.status).toBe('discarded');
  expect(detail.imageAvailable).toBe(false);
  expect((await request.get(`/api/receipts/${receiptId}/image`)).status()).toBe(
    404,
  );

  // It drops out of the list…
  await page.getByRole('button', { name: 'Back to receipts' }).click();
  await expect(page.locator('.receipt-list .receipt-card')).toHaveCount(
    before - 1,
  );

  // …while its own detail stays queryable, and its bytes capture again: the
  // discarded hash no longer blocks the upload.
  expect(
    (await (await request.get(`/api/receipts/${receiptId}`)).json()) as {
      status: string;
    },
  ).toMatchObject({ status: 'discarded' });
  const again = await captureUnique(request, tag);
  expect(again).not.toBe(receiptId);
});
