import { describe, expect, it } from 'vitest';
import {
  unknownBindErrorMessage,
  unknownBindNotice,
  unknownBindQuestion,
  unidentifiedSpendSummary,
  unknownGroupLabel,
  unknownLineCountLabel,
} from '../../src/lib/client/receipt-unknowns';
import { ApiError } from '../../src/lib/client/api';
import type {
  UnknownLineGroup,
  UnknownLinesOverview,
} from '../../src/lib/shared/schemas';

/**
 * The grouped browser's client half (ticket 17): the sentences that turn a
 * group's counts and money into the unidentified-spending view, and the
 * deliberate second tap that binds a whole wording.
 */

function group(overrides: Partial<UnknownLineGroup> = {}): UnknownLineGroup {
  return {
    normalizedText: 'mystery item',
    printedText: 'MYSTERY ITEM',
    lineCount: 3,
    receiptCount: 2,
    spendMinor: 749,
    ...overrides,
  };
}

function overview(
  overrides: Partial<UnknownLinesOverview> = {},
): UnknownLinesOverview {
  return {
    currency: 'USD',
    groups: [group()],
    lineCount: 3,
    spendMinor: 749,
    ...overrides,
  };
}

describe('unknownLineCountLabel', () => {
  it('counts one line and many lines in words', () => {
    expect(unknownLineCountLabel(1)).toBe('1 line');
    expect(unknownLineCountLabel(3)).toBe('3 lines');
    expect(unknownLineCountLabel(0)).toBe('0 lines');
  });
});

describe('unknownGroupLabel', () => {
  it('shows the printed wording, and says so when there is none', () => {
    expect(unknownGroupLabel(group())).toBe('MYSTERY ITEM');
    expect(
      unknownGroupLabel(group({ normalizedText: '', printedText: ' ' })),
    ).toBe('(no printed text)');
  });
});

describe('unidentifiedSpendSummary', () => {
  it('reads as the unidentified-spending total', () => {
    expect(unidentifiedSpendSummary(overview())).toMatch(
      /^3 lines across 1 wording .*7\.49 unidentified\.$/u,
    );
  });

  it('counts wordings separately from lines', () => {
    expect(
      unidentifiedSpendSummary(
        overview({
          groups: [
            group({ normalizedText: 'a', printedText: 'A', spendMinor: 300 }),
            group({
              normalizedText: 'b',
              printedText: 'B',
              lineCount: 1,
              spendMinor: 200,
            }),
          ],
          lineCount: 4,
          spendMinor: 500,
        }),
      ),
    ).toMatch(/^4 lines across 2 wordings .*5\.00 unidentified\.$/u);
  });

  it('says there is nothing unidentified when every line has an item', () => {
    expect(
      unidentifiedSpendSummary(
        overview({ groups: [], lineCount: 0, spendMinor: 0 }),
      ),
    ).toBe('No unidentified spending — every committed line has an item.');
  });
});

describe('the batch bind sentences', () => {
  it('asks for the tap and says what the bind teaches', () => {
    expect(unknownBindQuestion(group(), 'Milk')).toBe(
      'Bind 3 lines to Milk? Matching will learn "MYSTERY ITEM" for Milk.',
    );
  });

  it('counts a one-line group in the singular', () => {
    expect(unknownBindQuestion(group({ lineCount: 1 }), 'Milk')).toBe(
      'Bind 1 line to Milk? Matching will learn "MYSTERY ITEM" for Milk.',
    );
  });

  it('reports how many lines the bind actually changed', () => {
    expect(unknownBindNotice(group(), 'Milk', 2)).toBe(
      'Bound 2 lines to Milk. Matching will learn "MYSTERY ITEM" for Milk.',
    );
  });

  it('promises no alias when there is no printed wording to learn', () => {
    const blank = group({ normalizedText: '', printedText: '' });

    expect(unknownBindQuestion(blank, 'Milk')).toBe(
      'Bind 3 lines to Milk? The lines have no printed wording, so matching learns nothing.',
    );
    expect(unknownBindNotice(blank, 'Milk', 2)).toBe(
      'Bound 2 lines to Milk. The lines have no printed wording, so matching learns nothing.',
    );
  });
});

describe('unknownBindErrorMessage', () => {
  it('explains a wording that has already been bound elsewhere', () => {
    expect(
      unknownBindErrorMessage(
        new ApiError(404, 'NOT_FOUND', 'No unknown lines carry that wording.'),
      ),
    ).toContain('no longer has any unknown lines');
  });

  it('explains a vanished item', () => {
    expect(
      unknownBindErrorMessage(
        new ApiError(400, 'INVALID_ITEM', 'Choose an item from this list.'),
      ),
    ).toContain('no longer in this list');
  });

  it('falls back to the server sentence, then to its own', () => {
    expect(
      unknownBindErrorMessage(
        new ApiError(400, 'VALIDATION_ERROR', 'Check the submitted fields.'),
      ),
    ).toBe('Check the submitted fields.');
    expect(unknownBindErrorMessage(new Error('offline'))).toBe(
      'The lines could not be bound. Try again.',
    );
  });
});
