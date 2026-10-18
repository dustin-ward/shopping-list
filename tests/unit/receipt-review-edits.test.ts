import { describe, expect, it } from 'vitest';
import {
  resolveLineEdit,
  type EditableLine,
} from '../../src/lib/server/receipts/review-edits';
import { AppError } from '../../src/lib/server/errors';

/** A stored item line: unreviewed, no binding, one price. */
function line(overrides: Partial<EditableLine> = {}): EditableLine {
  return {
    rawText: 'MILK 2% 1L',
    quantityReal: null,
    quantityText: null,
    quantityUnit: null,
    unitPriceMinor: null,
    totalPriceMinor: 349,
    reviewState: 'unreviewed',
    catalogItemId: null,
    boundVia: null,
    boundRank: null,
    ...overrides,
  };
}

function caught(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected the edit to be refused');
}

describe('resolveLineEdit', () => {
  it('applies the edited fields and leaves the untouched ones alone', () => {
    const resolved = resolveLineEdit(line(), {
      rawText: 'MILK 2% 1L',
      quantityReal: 2,
      quantityText: '2 @ 1.50',
      quantityUnit: 'ea',
      unitPriceMinor: 150,
      totalPriceMinor: 300,
    });

    expect(resolved).toEqual({
      rawText: 'MILK 2% 1L',
      quantityReal: 2,
      quantityText: '2 @ 1.50',
      quantityUnit: 'ea',
      unitPriceMinor: 150,
      totalPriceMinor: 300,
      reviewState: 'unreviewed',
      catalogItemId: null,
      boundVia: null,
      boundRank: null,
    });
  });

  it('clears a field the reviewer emptied', () => {
    const resolved = resolveLineEdit(
      line({ quantityReal: 2, quantityUnit: 'ea', unitPriceMinor: 150 }),
      { quantityReal: null, quantityUnit: null, unitPriceMinor: null },
    );

    expect(resolved).toMatchObject({
      quantityReal: null,
      quantityUnit: null,
      unitPriceMinor: null,
    });
  });

  it('clears the binding when the line is marked unknown', () => {
    const resolved = resolveLineEdit(
      line({
        reviewState: 'bound',
        catalogItemId: '00000000-0000-4000-8000-0000000000aa',
        boundVia: 'auto',
      }),
      { reviewState: 'unknown' },
    );

    expect(resolved).toMatchObject({
      reviewState: 'unknown',
      catalogItemId: null,
      boundVia: null,
      boundRank: null,
    });
  });

  it('clears the binding when a bound line is skipped or released', () => {
    const bound = {
      reviewState: 'bound' as const,
      catalogItemId: '00000000-0000-4000-8000-0000000000aa',
      boundVia: 'auto' as const,
    };

    expect(
      resolveLineEdit(line(bound), { reviewState: 'skipped' }),
    ).toMatchObject({ catalogItemId: null, boundVia: null });
    expect(
      resolveLineEdit(line(bound), { reviewState: 'unreviewed' }),
    ).toMatchObject({ catalogItemId: null, boundVia: null });
  });

  it('keeps a draft item off the line while it is still new', () => {
    const resolved = resolveLineEdit(line(), { reviewState: 'new' });

    expect(resolved).toMatchObject({
      reviewState: 'new',
      catalogItemId: null,
      boundVia: null,
    });
  });

  it('binds to the chosen item and records the human as the source', () => {
    const resolved = resolveLineEdit(line(), {
      reviewState: 'bound',
      catalogItemId: '00000000-0000-4000-8000-0000000000aa',
    });

    expect(resolved).toMatchObject({
      reviewState: 'bound',
      catalogItemId: '00000000-0000-4000-8000-0000000000aa',
      boundVia: 'manual',
      boundRank: null,
    });
  });

  it('keeps the item a bound line already sits on', () => {
    const itemId = '00000000-0000-4000-8000-0000000000aa';
    const resolved = resolveLineEdit(
      line({ catalogItemId: itemId, reviewState: 'bound', boundVia: 'auto' }),
      { reviewState: 'bound' },
    );

    expect(resolved).toMatchObject({ catalogItemId: itemId, boundVia: 'auto' });
  });

  it('drops provenance that described the item the line is re-pointed away from', () => {
    const itemId = '00000000-0000-4000-8000-0000000000aa';
    const otherId = '00000000-0000-4000-8000-0000000000bb';

    const resolved = resolveLineEdit(
      line({
        catalogItemId: itemId,
        reviewState: 'bound',
        boundVia: 'suggested',
        boundRank: 3,
      }),
      { reviewState: 'bound', catalogItemId: otherId },
    );

    expect(resolved).toMatchObject({
      catalogItemId: otherId,
      boundVia: 'manual',
      boundRank: null,
    });
  });

  it('records an accepted suggestion with its rank', () => {
    const resolved = resolveLineEdit(line(), {
      reviewState: 'bound',
      catalogItemId: '00000000-0000-4000-8000-0000000000aa',
      boundVia: 'suggested',
      boundRank: 2,
    });

    expect(resolved).toMatchObject({ boundVia: 'suggested', boundRank: 2 });
  });

  it('refuses a bound line with no item to bind to', () => {
    const error = caught(() =>
      resolveLineEdit(line({ reviewState: 'bound' }), { reviewState: 'bound' }),
    );

    expect(error).toMatchObject({ status: 400, code: 'INVALID_LINE_BINDING' });
  });

  it('refuses provenance on a line that is not bound', () => {
    expect(
      caught(() =>
        resolveLineEdit(line(), {
          reviewState: 'skipped',
          catalogItemId: '00000000-0000-4000-8000-0000000000aa',
          boundVia: 'manual',
        }),
      ),
    ).toMatchObject({ status: 400, code: 'INVALID_LINE_BINDING' });
    expect(
      caught(() => resolveLineEdit(line(), { boundVia: 'manual' })),
    ).toMatchObject({ status: 400, code: 'INVALID_LINE_BINDING' });
  });

  it('refuses a rank that is not an accepted suggestion’s', () => {
    expect(
      caught(() =>
        resolveLineEdit(line(), {
          reviewState: 'bound',
          catalogItemId: '00000000-0000-4000-8000-0000000000aa',
          boundVia: 'manual',
          boundRank: 1,
        }),
      ),
    ).toMatchObject({ status: 400, code: 'INVALID_LINE_BINDING' });
  });
});
