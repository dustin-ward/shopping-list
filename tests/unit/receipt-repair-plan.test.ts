import { describe, expect, it } from 'vitest';
import {
  planLineRepair,
  type LineAlias,
  type RepairableLine,
} from '../../src/lib/server/receipts/repair-plan';

/**
 * What one committed line's repair decides, without a database: the binding the
 * correction lands on, the alias this line taught that stops binding, and the
 * alias the new binding teaches (ticket 16; `ADR 0003`).
 */

const LINE_ID = '00000000-0000-4000-8000-0000000000aa';
const OLD_ITEM = '00000000-0000-4000-8000-0000000000bb';
const NEW_ITEM = '00000000-0000-4000-8000-0000000000cc';

/** A committed item line: bound to the old item, its printed text already learned. */
function line(overrides: Partial<RepairableLine> = {}): RepairableLine {
  return {
    id: LINE_ID,
    rawText: 'MILK 2% 1L',
    quantityReal: null,
    quantityText: null,
    quantityUnit: null,
    unitPriceMinor: null,
    totalPriceMinor: 349,
    reviewState: 'bound',
    catalogItemId: OLD_ITEM,
    boundVia: 'auto',
    boundRank: null,
    ...overrides,
  };
}

/** The live aliases the line taught — the old item's, and maybe the new one's. */
const TAUGHT: LineAlias[] = [
  { id: 'alias-old', catalogItemId: OLD_ITEM },
  { id: 'alias-new', catalogItemId: NEW_ITEM },
];

describe('planLineRepair', () => {
  it('rebinds the line to another item as the reviewer’s own correction', () => {
    const repair = planLineRepair(line(), { catalogItemId: NEW_ITEM }, TAUGHT);

    expect(repair).toEqual({
      lineId: LINE_ID,
      reviewState: 'bound',
      catalogItemId: NEW_ITEM,
      boundVia: 'manual',
      boundRank: null,
      retractAliasIds: ['alias-old'],
      learnAlias: {
        aliasText: 'MILK 2% 1L',
        normalizedAlias: 'milk 2% 1l',
      },
    });
  });

  it('keeps an accepted suggestion’s provenance and rank on the repaired binding', () => {
    const repair = planLineRepair(
      line(),
      {
        reviewState: 'bound',
        catalogItemId: NEW_ITEM,
        boundVia: 'suggested',
        boundRank: 2,
      },
      TAUGHT,
    );

    expect(repair).toMatchObject({
      catalogItemId: NEW_ITEM,
      boundVia: 'suggested',
      boundRank: 2,
    });
  });

  it('retracts every alias this line taught when the line is released', () => {
    const repair = planLineRepair(line(), { reviewState: 'unknown' }, TAUGHT);

    expect(repair).toEqual({
      lineId: LINE_ID,
      reviewState: 'unknown',
      catalogItemId: null,
      boundVia: null,
      boundRank: null,
      retractAliasIds: ['alias-old', 'alias-new'],
      learnAlias: null,
    });
  });

  it('leaves the alias this line taught for the item it still binds alone', () => {
    const repair = planLineRepair(
      line(),
      { reviewState: 'bound', catalogItemId: OLD_ITEM },
      [{ id: 'alias-old', catalogItemId: OLD_ITEM }],
    );

    // The alias the line taught for the item it still binds keeps binding; the
    // relearn is emitted anyway, so a soft-deleted row is revived by the repair.
    expect(repair.retractAliasIds).toEqual([]);
    expect(repair.learnAlias).toEqual({
      aliasText: 'MILK 2% 1L',
      normalizedAlias: 'milk 2% 1l',
    });
  });

  it('retracts the alias this line taught for an item it left behind', () => {
    const repair = planLineRepair(
      line({ catalogItemId: OLD_ITEM }),
      { reviewState: 'bound', catalogItemId: OLD_ITEM },
      TAUGHT,
    );

    // `alias-new` is not the binding: a line that once meant another item stops
    // teaching it, whatever the current binding is.
    expect(repair.retractAliasIds).toEqual(['alias-new']);
  });

  it('binds a line the reviewer could not identify before', () => {
    const repair = planLineRepair(
      line({ reviewState: 'unknown', catalogItemId: null, boundVia: null }),
      { reviewState: 'bound', catalogItemId: NEW_ITEM },
      [],
    );

    expect(repair).toMatchObject({
      reviewState: 'bound',
      catalogItemId: NEW_ITEM,
      boundVia: 'manual',
      boundRank: null,
    });
    expect(repair.learnAlias).toEqual({
      aliasText: 'MILK 2% 1L',
      normalizedAlias: 'milk 2% 1l',
    });
  });

  it('has nothing to teach when the printed text carries no words', () => {
    const repair = planLineRepair(line({ rawText: '   ' }), {}, []);

    expect(repair.learnAlias).toBeNull();
    // The line itself is untouched: a repair that changed nothing still says
    // what the line holds.
    expect(repair).toMatchObject({
      catalogItemId: OLD_ITEM,
      reviewState: 'bound',
      boundVia: 'auto',
    });
  });
});
