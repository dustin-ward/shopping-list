import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/lib/client/api';
import {
  aliasDeleteErrorMessage,
  aliasSourceLabel,
  ambiguitySentence,
  deletedAliasCount,
  visibleAliases,
} from '../../src/lib/client/receipt-aliases';
import type {
  AliasOverview,
  ItemAlias,
  ItemAliases,
} from '../../src/lib/shared/schemas';

/**
 * The alias surface's rules, away from the browser: which rows the audit view
 * reveals, how a learned row and an ambiguous phrase describe themselves, and
 * what the reviewer is told when a delete is refused.
 */

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

describe('visibleAliases', () => {
  it('shows live aliases and hides deleted ones by default', () => {
    const live = alias();
    const deleted = alias({
      id: '00000000-0000-4000-8000-000000000002',
      aliasText: 'MILK 1GAL',
      deletedAt: '2026-10-16T09:00:00.000Z',
    });

    expect(visibleAliases(item({ aliases: [live, deleted] }), false)).toEqual([
      live,
    ]);
  });

  it('shows the deleted rows too once the audit view is on', () => {
    const live = alias();
    const deleted = alias({
      id: '00000000-0000-4000-8000-000000000002',
      deletedAt: '2026-10-16T09:00:00.000Z',
    });

    expect(visibleAliases(item({ aliases: [live, deleted] }), true)).toEqual([
      live,
      deleted,
    ]);
  });
});

describe('deletedAliasCount', () => {
  it('counts every deleted row across the items', () => {
    const body = overview({
      items: [
        item({
          aliases: [alias(), alias({ deletedAt: '2026-10-16T09:00:00.000Z' })],
        }),
        item({
          catalogItemId: '00000000-0000-4000-8000-0000000000bb',
          name: 'Bread',
          aliases: [alias({ deletedAt: '2026-10-14T09:00:00.000Z' })],
        }),
      ],
    });

    expect(deletedAliasCount(body)).toBe(2);
  });

  it('is zero when nothing has been deleted', () => {
    expect(deletedAliasCount(overview())).toBe(0);
  });
});

describe('aliasSourceLabel', () => {
  it('says where each kind of row came from', () => {
    // The three sources the schema stores, each in the reviewer's words.
    expect(aliasSourceLabel('review')).toBe('Learned in review');
    expect(aliasSourceLabel('manual')).toBe('Confirmed by hand');
    expect(aliasSourceLabel('auto')).toBe('Learned automatically');
  });
});

describe('ambiguitySentence', () => {
  const phrase = (names: string[]) => ({
    phrase: 'CORN FLAKES',
    normalizedPhrase: 'corn flakes',
    items: names.map((name, index) => ({
      catalogItemId: `00000000-0000-4000-8000-00000000000${index}`,
      name,
    })),
  });

  it('names both claimants', () => {
    expect(ambiguitySentence(phrase(['Cereal', 'Flakes']))).toBe(
      'CORN FLAKES is claimed by Cereal and Flakes — matching asks instead of guessing.',
    );
  });

  it('reads as a list with three claimants', () => {
    expect(ambiguitySentence(phrase(['Cereal', 'Flakes', 'Granola']))).toBe(
      'CORN FLAKES is claimed by Cereal, Flakes and Granola — matching asks instead of guessing.',
    );
  });
});

describe('aliasDeleteErrorMessage', () => {
  it('explains a row that is already gone as a refreshed list', () => {
    expect(
      aliasDeleteErrorMessage(
        new ApiError(404, 'NOT_FOUND', 'Alias not found.'),
      ),
    ).toBe('That alias no longer exists — the list has been refreshed.');
  });

  it('passes a server sentence through and covers the offline case', () => {
    expect(
      aliasDeleteErrorMessage(new ApiError(409, 'OTHER', 'Something else.')),
    ).toBe('Something else.');
    expect(aliasDeleteErrorMessage(new Error('offline'))).toBe(
      'The alias could not be deleted. Try again.',
    );
  });
});
