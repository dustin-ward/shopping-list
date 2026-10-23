import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import ReceiptAliases from '../../src/lib/components/receipts/ReceiptAliases.svelte';
import type {
  AliasOverview,
  ItemAlias,
  ItemAliases,
} from '../../src/lib/shared/schemas';

/**
 * The alias surface as the reviewer meets it: every learned wording under the
 * item it answers to, a delete that asks twice and says what it does, the
 * soft-deleted rows behind an explicit audit view, and the phrases two items
 * claim — the ones matching asked about rather than resolving.
 */

function readable(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/gu, '').replace(/ svelte-\w+/gu, '');
}

function alias(overrides: Partial<ItemAlias> = {}): ItemAlias {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    aliasText: 'DAIRYLAND 2% 1L',
    normalizedAlias: 'dairyland 2% 1l',
    source: 'review',
    createdAt: '2026-10-15T10:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

function item(overrides: Partial<ItemAliases> = {}): ItemAliases {
  return {
    catalogItemId: '00000000-0000-4000-8000-0000000000aa',
    name: 'Milk',
    aliases: [alias()],
    ...overrides,
  };
}

function overview(overrides: Partial<AliasOverview> = {}): AliasOverview {
  return { items: [item()], ambiguous: [], ...overrides };
}

const noop = () => {};

/** The props under test; the rest are the container's to own. */
type AliasProps = {
  writable?: boolean;
  includeDeleted?: boolean;
  pendingDeleteId?: string | null;
};

function renderAliases(
  body: AliasOverview,
  {
    writable = true,
    includeDeleted = false,
    pendingDeleteId = null,
  }: AliasProps = {},
): string {
  return readable(
    render(ReceiptAliases, {
      props: {
        overview: body,
        writable,
        includeDeleted,
        pendingDeleteId,
        onToggleDeleted: noop,
        onRequestDelete: noop,
        onCancelDelete: noop,
        onConfirmDelete: noop,
      },
    }).body,
  );
}

describe('ReceiptAliases — viewing aliases per item', () => {
  it('lists an item\u2019s aliases with where they came from and when', () => {
    const body = renderAliases(
      overview({
        items: [
          item({
            aliases: [
              alias(),
              alias({
                id: '00000000-0000-4000-8000-000000000002',
                aliasText: 'MILK 1GAL',
                source: 'manual',
              }),
            ],
          }),
        ],
      }),
    );

    // The item is the heading; its wordings are the rows.
    expect(body).toContain('>Milk</h3>');
    expect(body).toContain('DAIRYLAND 2% 1L');
    expect(body).toContain('MILK 1GAL');
    expect(body).toContain('Learned in review');
    expect(body).toContain('Confirmed by hand');
    expect(body).toMatch(/Learned\s*(<!--[\s\S]*?-->)?\s*Oct/u);
  });

  it('says so, with the relearn, when nothing has been learned yet', () => {
    const body = renderAliases(overview({ items: [] }));

    expect(body).toContain('No aliases to show.');
    expect(body).toContain('Committing a reviewed receipt');
  });
});

describe('ReceiptAliases — the audit view', () => {
  const withDeleted = overview({
    items: [
      item({
        aliases: [
          alias(),
          alias({
            id: '00000000-0000-4000-8000-000000000002',
            aliasText: 'MILK 1GAL',
            deletedAt: '2026-10-16T09:00:00.000Z',
          }),
        ],
      }),
    ],
  });

  it('hides deleted rows and offers them behind a counted toggle', () => {
    const body = renderAliases(withDeleted);

    expect(body).toContain('Show deleted aliases (1)');
    expect(body).not.toContain('MILK 1GAL');
    expect(body).not.toContain('Kept for audit');
  });

  it('reveals the deleted row, and keeps saying why it is still there', () => {
    const body = renderAliases(withDeleted, { includeDeleted: true });

    expect(body).toContain('Hide deleted aliases');
    expect(body).toContain('MILK 1GAL');
    expect(body).toContain('Kept for audit');
    expect(body).toContain('class="alias-row deleted"');
  });
});

describe('ReceiptAliases — deleting a wrong alias', () => {
  it('offers one delete per live row, and nothing on a deleted one', () => {
    const body = renderAliases(
      overview({
        items: [
          item({
            aliases: [
              alias(),
              alias({
                id: '00000000-0000-4000-8000-000000000002',
                aliasText: 'MILK 1GAL',
                deletedAt: '2026-10-16T09:00:00.000Z',
              }),
            ],
          }),
        ],
      }),
      { includeDeleted: true },
    );

    expect(body).toContain('Delete alias DAIRYLAND 2% 1L');
    expect(body).not.toContain('Delete alias MILK 1GAL');
  });

  it('asks before deleting, and says what deleting does', () => {
    const body = renderAliases(overview(), {
      pendingDeleteId: '00000000-0000-4000-8000-000000000001',
    });

    expect(body).toContain('Deleting stops auto-binding; the row is kept for');
    expect(body).toContain('Delete alias');
    expect(body).toContain('Cancel');
    // The one-tap button is gone while the confirm stands.
    expect(body).not.toContain('aria-label="Delete alias DAIRYLAND 2% 1L"');
  });

  it('offers no delete at all without a writable connection', () => {
    const body = renderAliases(overview(), { writable: false });

    expect(body).not.toContain('Delete');
    expect(body).toContain('DAIRYLAND 2% 1L');
  });
});

describe('ReceiptAliases — ambiguous phrases', () => {
  it('names every claiming item, so the reviewer sees why matching asked', () => {
    const body = renderAliases(
      overview({
        ambiguous: [
          {
            phrase: 'CORN FLAKES',
            normalizedPhrase: 'corn flakes',
            items: [
              {
                catalogItemId: '00000000-0000-4000-8000-0000000000aa',
                name: 'Breakfast Cereal',
              },
              {
                catalogItemId: '00000000-0000-4000-8000-0000000000bb',
                name: 'Corn Flakes',
              },
            ],
          },
        ],
      }),
    );

    expect(body).toContain('Matching asks about these phrases');
    expect(body).toContain(
      'CORN FLAKES is claimed by Breakfast Cereal and Corn Flakes',
    );
    expect(body).toContain('matching asks instead of guessing');
  });

  it('has no panel while nothing is ambiguous', () => {
    expect(renderAliases(overview())).not.toContain(
      'Matching asks about these phrases',
    );
  });
});
