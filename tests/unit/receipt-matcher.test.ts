import { describe, expect, it } from 'vitest';
import { normalizeName } from '../../src/lib/shared/normalize';
import {
  MAX_SUGGESTIONS,
  ambiguousPhrases,
  jaroWinkler,
  matchReceiptLine,
  phraseForLine,
  suggestionsForLines,
  type MatchContext,
  type MatcherItem,
} from '../../src/lib/server/receipts/matcher';

/**
 * Golden cases for the deterministic matcher (plan §7): tier 1 binds on a
 * normalized exact name or a human-confirmed alias, tier 2 ranks fuzzy
 * candidates, and the ambiguity guard refuses to choose between two items.
 *
 * Scores are asserted exactly where they are hand-derivable — the token overlap
 * is arithmetic, and the Jaro-Winkler values come from the published examples
 * asserted above, so these numbers are not recomputed the way the code does.
 */

let sequence = 0;

function id(): string {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function item(name: string, overrides: Partial<MatcherItem> = {}): MatcherItem {
  return {
    catalogItemId: id(),
    name,
    normalizedName: normalizeName(name),
    sameStore: false,
    ...overrides,
  };
}

function context(
  items: MatcherItem[],
  aliases: { alias: string; item: MatcherItem }[] = [],
): MatchContext {
  return {
    items,
    aliases: aliases.map(({ alias, item: target }) => ({
      catalogItemId: target.catalogItemId,
      aliasText: alias,
      normalizedAlias: normalizeName(alias),
    })),
  };
}

function suggestionNames(
  result: ReturnType<typeof matchReceiptLine>,
): string[] {
  return result.suggestions.map((suggestion) => suggestion.name);
}

describe('jaroWinkler', () => {
  // The classic published examples (Wikipedia's Jaro-Winkler article), which is
  // the independent source of truth for the implementation itself.
  it('matches the published examples', () => {
    expect(jaroWinkler('MARTHA', 'MARHTA')).toBeCloseTo(0.961, 3);
    expect(jaroWinkler('DWAYNE', 'DUANE')).toBeCloseTo(0.84, 3);
    expect(jaroWinkler('DIXON', 'DICKSONX')).toBeCloseTo(0.813, 3);
  });

  it('is 1 for identical strings and 0 when nothing matches', () => {
    expect(jaroWinkler('milk', 'milk')).toBe(1);
    expect(jaroWinkler('milk', 'zzzz')).toBe(0);
  });
});

describe('tier 1 — exact name and alias matches bind', () => {
  it('binds an item whose normalized name equals the printed name', () => {
    const milk = item('Milk');

    const result = matchReceiptLine('MILK', context([milk]));

    expect(result.bind).toBe(milk.catalogItemId);
    expect(result.suggestions).toEqual([
      {
        catalogItemId: milk.catalogItemId,
        name: 'Milk',
        tier: 1,
        score: 1,
        sameStore: false,
      },
    ]);
  });

  it('binds an item a human confirmed the printed variant for', () => {
    const bread = item('Bread');
    const milk = item('Milk');

    const result = matchReceiptLine(
      'SOURDOUGH BREAD',
      context([milk, bread], [{ alias: 'SOURDOUGH BREAD', item: bread }]),
    );

    expect(result.bind).toBe(bread.catalogItemId);
    expect(result.suggestions).toEqual([
      expect.objectContaining({ name: 'Bread', tier: 1 }),
    ]);
  });

  it('prefers the one tier-1 candidate without crowding it with fuzzy ones', () => {
    const milk = item('Milk');
    const milkSize = item('Milk 2%');

    const result = matchReceiptLine('MILK', context([milk, milkSize]));

    expect(result.bind).toBe(milk.catalogItemId);
    expect(result.suggestions).toEqual([
      expect.objectContaining({ name: 'Milk', tier: 1 }),
    ]);
  });

  it('carries the same-store evidence onto the suggestion', () => {
    const milk = item('Milk', { sameStore: true });

    const [suggestion] = matchReceiptLine('MILK', context([milk])).suggestions;

    expect(suggestion).toMatchObject({ sameStore: true });
  });
});

describe('tier 1 — the ambiguity guard', () => {
  it('never auto-binds a phrase that maps to two items, and asks instead', () => {
    const flakes = item('Corn Flakes');
    const cereal = item('Breakfast Cereal');

    const result = matchReceiptLine(
      'CORN FLAKES',
      context(
        [flakes, cereal],
        [
          { alias: 'CORN FLAKES', item: flakes },
          { alias: 'CORN FLAKES', item: cereal },
        ],
      ),
    );

    expect(result.bind).toBeNull();
    expect(result.suggestions).toEqual([
      expect.objectContaining({ name: 'Breakfast Cereal', tier: 1 }),
      expect.objectContaining({ name: 'Corn Flakes', tier: 1 }),
    ]);
  });

  it('treats an alias pointing elsewhere as a conflict with an exact name', () => {
    const milk = item('Milk');
    const otherMilk = item('Buttermilk');

    const result = matchReceiptLine(
      'MILK',
      context([milk, otherMilk], [{ alias: 'MILK', item: otherMilk }]),
    );

    expect(result.bind).toBeNull();
    expect(result.suggestions).toHaveLength(2);
  });

  it('never returns more than five candidates', () => {
    const items = Array.from({ length: 7 }, (_, index) =>
      item(`Item ${index}`),
    );

    const result = matchReceiptLine(
      'HOUSEHOLD THING',
      context(
        items,
        items.map((target) => ({ alias: 'HOUSEHOLD THING', item: target })),
      ),
    );

    expect(result.bind).toBeNull();
    expect(result.suggestions).toHaveLength(MAX_SUGGESTIONS);
  });
});

describe('ambiguousPhrases — the phrases matching refuses to resolve', () => {
  it('reports a phrase claimed by two items, with the printed wording', () => {
    const flakes = item('Flakes');
    const cereal = item('Cereal');

    const ambiguous = ambiguousPhrases(
      context(
        [flakes, cereal],
        [
          { alias: 'CORN FLAKES', item: flakes },
          { alias: 'CORN FLAKES', item: cereal },
        ],
      ),
    );

    expect(ambiguous).toEqual([
      {
        phrase: 'CORN FLAKES',
        normalizedPhrase: 'corn flakes',
        items: [
          { catalogItemId: cereal.catalogItemId, name: 'Cereal' },
          { catalogItemId: flakes.catalogItemId, name: 'Flakes' },
        ],
      },
    ]);
  });

  it('counts an item name and another item\u2019s alias as the conflict', () => {
    const milk = item('Milk');
    const otherMilk = item('Buttermilk');

    const ambiguous = ambiguousPhrases(
      context([milk, otherMilk], [{ alias: 'MILK', item: otherMilk }]),
    );

    // The household name is the wording shown: it is what the reviewer called
    // the item, and the alias is the printed variant in conflict with it.
    expect(ambiguous).toEqual([
      {
        phrase: 'Milk',
        normalizedPhrase: 'milk',
        items: [
          { catalogItemId: otherMilk.catalogItemId, name: 'Buttermilk' },
          { catalogItemId: milk.catalogItemId, name: 'Milk' },
        ],
      },
    ]);
  });

  it('leaves a phrase only one item claims alone', () => {
    const bread = item('Bread');
    const milk = item('Milk');

    expect(
      ambiguousPhrases(
        context([milk, bread], [{ alias: 'SOURDOUGH BREAD', item: bread }]),
      ),
    ).toEqual([]);
  });

  it('does not report two aliases that point at the same item', () => {
    const bread = item('Bread');

    expect(
      ambiguousPhrases(
        context(
          [bread],
          [
            { alias: 'SOURDOUGH BREAD', item: bread },
            { alias: 'SOURDOUGH LOAF', item: bread },
          ],
        ),
      ),
    ).toEqual([]);
  });

  it('orders phrases by their normalized form, not by claim order', () => {
    const first = item('Zucchini');
    const second = item('Zucchini Bread');
    const a = item('Apples');
    const b = item('Applesauce');

    const ambiguous = ambiguousPhrases(
      context(
        [first, second, a, b],
        [
          { alias: 'ZUCCHINI', item: first },
          { alias: 'ZUCCHINI', item: second },
          { alias: 'APPLES', item: a },
          { alias: 'APPLES', item: b },
        ],
      ),
    );

    expect(ambiguous.map((entry) => entry.normalizedPhrase)).toEqual([
      'apples',
      'zucchini',
    ]);
  });
});

describe('tier 2 — fuzzy suggestions', () => {
  it('reads a printed size as packaging, not identity, and penalizes it', () => {
    const milk = item('Milk');
    const milkSize = item('Milk 2%');

    const result = matchReceiptLine('MILK 2% 1L', context([milk, milkSize]));

    // Never bound: a fuzzy match is a tap away, not a decision.
    expect(result.bind).toBeNull();
    // Both candidates overlap on "milk" alone (Jaccard 1.0); "Milk 2%" also
    // matches the printed size, so it keeps a 0.94 Jaro-Winkler score and only
    // the unmatched "1l" costs it; "Milk" loses both packaging tokens.
    expect(result.suggestions).toEqual([
      {
        catalogItemId: milkSize.catalogItemId,
        name: 'Milk 2%',
        tier: 2,
        score: 0.92,
        sameStore: false,
      },
      {
        catalogItemId: milk.catalogItemId,
        name: 'Milk',
        tier: 2,
        score: 0.84,
        sameStore: false,
      },
    ]);
  });

  it('ranks a candidate confirmed at the same store above a closer string match', () => {
    const milk = item('Milk', { sameStore: true });
    const milkSize = item('Milk 2%');

    const result = matchReceiptLine('MILK 2% 1L', context([milk, milkSize]));

    expect(suggestionNames(result)).toEqual(['Milk', 'Milk 2%']);
    expect(result.suggestions[0]!.score).toBeCloseTo(0.94, 4);
    expect(result.suggestions[1]!.score).toBeCloseTo(0.92, 4);
  });

  it('stays below the Jaccard boundary when a significant word is extra', () => {
    const apples = item('Apples', { sameStore: true });

    // "gala" is identity, not packaging: {gala, apples} vs {apples} is 0.5.
    expect(matchReceiptLine('GALA APPLES 3LB', context([apples]))).toEqual({
      bind: null,
      suggestions: [],
    });
  });

  it('stays below the Jaro-Winkler boundary when the printed order differs', () => {
    const milkSize = item('Milk 2%', { sameStore: true });

    // The token sets agree, but "2% milk" is not the string "milk 2%", and the
    // tier-1 alias path is what fixes a phrasing once a human confirms it.
    expect(matchReceiptLine('2% MILK', context([milkSize]))).toEqual({
      bind: null,
      suggestions: [],
    });
  });

  it('suggests nothing for a phrase that is packaging alone', () => {
    const milk = item('Milk', { sameStore: true });

    expect(matchReceiptLine('2 LB', context([milk])).suggestions).toEqual([]);
    expect(matchReceiptLine('6CT', context([milk])).suggestions).toEqual([]);
  });

  it('suggests nothing when the phrase is blank', () => {
    expect(matchReceiptLine('   ', context([item('Milk')]))).toEqual({
      bind: null,
      suggestions: [],
    });
  });
});

describe('phraseForLine', () => {
  it('matches on the parsed name, falling back to the printed text', () => {
    expect(
      phraseForLine({ parsedName: 'CUCUMBERS', rawText: 'CUCUMBERS 2 @ 1.50' }),
    ).toBe('CUCUMBERS');
    expect(phraseForLine({ parsedName: null, rawText: 'FLOUR' })).toBe('FLOUR');
    expect(phraseForLine({ parsedName: '  ', rawText: 'FLOUR' })).toBe('FLOUR');
  });
});

describe('suggestionsForLines', () => {
  it('attaches candidates to item lines and skips parked rows', () => {
    const milk = item('Milk');
    const byLine = suggestionsForLines(
      [
        {
          id: 'line-1',
          parsedName: 'MILK 2% 1L',
          rawText: 'MILK 2% 1L',
          isItemChunk: true,
        },
        {
          id: 'line-2',
          parsedName: null,
          rawText: 'SUBTOTAL',
          isItemChunk: false,
        },
        {
          id: 'line-3',
          parsedName: 'EGGS LARGE DOZEN',
          rawText: 'EGGS LARGE DOZEN',
          isItemChunk: true,
        },
      ],
      context([milk]),
    );

    expect(byLine.get('line-1')).toEqual([
      expect.objectContaining({ name: 'Milk', tier: 2 }),
    ]);
    expect(byLine.get('line-2')).toBeUndefined();
    expect(byLine.get('line-3')).toEqual([]);
  });
});
