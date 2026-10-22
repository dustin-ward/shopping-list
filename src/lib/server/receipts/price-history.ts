/**
 * Price history's rules (ticket 20; plan §8 "Prices API", §13 "R3 — price
 * collation"): per-item price history, "last paid per store", trends — with
 * unit normalization inside one measurement family only.
 *
 * Two rules shape everything here:
 *
 * - **A family is a hard boundary.** Mass compares per kilogram, volume per
 *   litre, count per each. A pound never becomes an each and no density is
 *   guessed between mass and volume, so the numbers a surface shows were always
 *   measured the same way.
 * - **Uncomparable lines still cost money.** A line whose unit is missing or
 *   outside the canonical set contributes its spend and its "last paid" but
 *   never a per-unit point. Spend and unit price answer different questions and
 *   are reported separately.
 *
 * The caller hands rows in chronological order (receipt `created_at`, receipt
 * id, line index, line id) and this function makes one linear pass over them:
 * grouping by store and family, then sorting the finished groups for display.
 */

import type {
  ItemPriceFamily,
  ItemPricePoint,
  ItemPrices,
  ItemStorePrices,
  PriceBaseUnit,
  PriceFamily,
  PriceTrend,
} from '../../shared/schemas';
import { PRICE_FAMILY_VALUES } from '../../shared/schemas';
import type { CanonicalQuantityUnit } from './quantity';

/** One committed item line, as the price query returns it. */
export type PriceHistoryRow = {
  storeGroupId: string;
  storeName: string;
  receiptId: string;
  /** The receipt's `created_at`: the authoritative record time. */
  receiptCreatedAt: string;
  lineId: string;
  printedText: string;
  totalPriceMinor: number | null;
  unitPriceMinor: number | null;
  quantityReal: number | null;
  quantityUnit: CanonicalQuantityUnit | null;
};

/**
 * One printed unit's worth of base units and the family it belongs to. The base
 * unit is deliberately coarse enough for integer minor units: cents per gram or
 * per millilitre would round real prices to zero, while cents per kilogram and
 * per litre stay exact enough to compare.
 */
type UnitConversion = {
  family: PriceFamily;
  unit: PriceBaseUnit;
  /** Base units in one printed unit. */
  factor: number;
};

const CONVERSIONS: Record<CanonicalQuantityUnit, UnitConversion> = {
  lb: { family: 'mass', unit: 'kg', factor: 0.45359237 },
  kg: { family: 'mass', unit: 'kg', factor: 1 },
  oz: { family: 'mass', unit: 'kg', factor: 0.028349523125 },
  g: { family: 'mass', unit: 'kg', factor: 0.001 },
  l: { family: 'volume', unit: 'l', factor: 1 },
  ml: { family: 'volume', unit: 'l', factor: 0.001 },
  ea: { family: 'count', unit: 'ea', factor: 1 },
};

export type NormalizedUnitPrice = {
  family: PriceFamily;
  unit: PriceBaseUnit;
  /** Minor units per base unit, rounded to the nearest minor unit. */
  priceMinor: number;
};

/** A line as the pure rules need it: money and quantity, no identities. */
export type PriceLineAmounts = {
  unitPriceMinor: number | null;
  totalPriceMinor: number | null;
  quantityReal: number | null;
};

/**
 * The line's price per printed unit: the stored unit price when the parser read
 * one, else the extended price divided by the quantity. Without a quantity
 * there is no per-unit answer — inventing one would invent a comparison.
 */
export function lineUnitPrice(line: PriceLineAmounts): number | null {
  if (line.unitPriceMinor !== null) return line.unitPriceMinor;
  if (
    line.totalPriceMinor !== null &&
    line.quantityReal !== null &&
    line.quantityReal > 0
  ) {
    return Math.round(line.totalPriceMinor / line.quantityReal);
  }
  return null;
}

/**
 * Normalize a per-printed-unit price into its family's base unit, or `null`
 * when the unit is not one the canonical set can name.
 *
 * A negative price is a discount or correction, not a unit price to compare, so
 * it stays in spend and out of the series. Zero is a real price (a free line)
 * and stays in the series.
 */
export function normalizeUnitPrice(
  unitPriceMinor: number,
  quantityUnit: CanonicalQuantityUnit | null,
): NormalizedUnitPrice | null {
  if (quantityUnit === null) return null;
  const conversion = CONVERSIONS[quantityUnit];
  if (!conversion || unitPriceMinor < 0) return null;
  return {
    family: conversion.family,
    unit: conversion.unit,
    priceMinor: Math.round(unitPriceMinor / conversion.factor),
  };
}

/** One line's comparable point, or `null` when the unit cannot be normalized. */
export function normalizeLine(
  row: PriceHistoryRow,
): (NormalizedUnitPrice & { quantityUnit: CanonicalQuantityUnit }) | null {
  const unitPriceMinor = lineUnitPrice(row);
  const quantityUnit = row.quantityUnit;
  if (unitPriceMinor === null || quantityUnit === null) return null;
  const normalized = normalizeUnitPrice(unitPriceMinor, quantityUnit);
  if (!normalized) return null;
  return { ...normalized, quantityUnit };
}

type FamilyAccumulator = {
  family: PriceFamily;
  unit: PriceBaseUnit;
  history: ItemPricePoint[];
  lastUnitPriceMinor: number;
  minUnitPriceMinor: number;
  maxUnitPriceMinor: number;
};

type StoreAccumulator = {
  storeGroupId: string;
  storeName: string;
  lineCount: number;
  spendMinor: number;
  lastPaidMinor: number | null;
  lastPaidAt: string;
  lastReceiptId: string;
  families: Map<PriceFamily, FamilyAccumulator>;
};

/** Turn chronological committed lines into the item's price history. */
export function summarizeItemPrices(
  item: { id: string; name: string },
  currency: string,
  rows: readonly PriceHistoryRow[],
): ItemPrices {
  const receiptIds = new Set<string>();
  const stores = new Map<string, StoreAccumulator>();

  for (const row of rows) {
    receiptIds.add(row.receiptId);
    let store = stores.get(row.storeGroupId);
    if (!store) {
      store = {
        storeGroupId: row.storeGroupId,
        storeName: row.storeName,
        lineCount: 0,
        spendMinor: 0,
        lastPaidMinor: null,
        lastPaidAt: row.receiptCreatedAt,
        lastReceiptId: row.receiptId,
        families: new Map(),
      };
      stores.set(row.storeGroupId, store);
    }

    store.lineCount += 1;
    if (row.totalPriceMinor !== null) store.spendMinor += row.totalPriceMinor;
    // Rows arrive oldest first, so the last row for a store is the last paid.
    store.lastPaidMinor = row.totalPriceMinor;
    store.lastPaidAt = row.receiptCreatedAt;
    store.lastReceiptId = row.receiptId;

    const normalized = normalizeLine(row);
    if (!normalized) continue;

    let family = store.families.get(normalized.family);
    if (!family) {
      family = {
        family: normalized.family,
        unit: normalized.unit,
        history: [],
        lastUnitPriceMinor: normalized.priceMinor,
        minUnitPriceMinor: normalized.priceMinor,
        maxUnitPriceMinor: normalized.priceMinor,
      };
      store.families.set(normalized.family, family);
    }

    family.history.push({
      receiptId: row.receiptId,
      lineId: row.lineId,
      receiptCreatedAt: row.receiptCreatedAt,
      printedText: row.printedText,
      quantityReal: row.quantityReal,
      quantityUnit: normalized.quantityUnit,
      totalPriceMinor: row.totalPriceMinor,
      normalizedUnitPriceMinor: normalized.priceMinor,
    });
    family.lastUnitPriceMinor = normalized.priceMinor;
    if (normalized.priceMinor < family.minUnitPriceMinor) {
      family.minUnitPriceMinor = normalized.priceMinor;
    }
    if (normalized.priceMinor > family.maxUnitPriceMinor) {
      family.maxUnitPriceMinor = normalized.priceMinor;
    }
  }

  const storeResults = [...stores.values()]
    .map(toStorePrices)
    .sort(
      (left, right) =>
        right.lastPaidAt.localeCompare(left.lastPaidAt) ||
        left.storeName.localeCompare(right.storeName) ||
        left.storeGroupId.localeCompare(right.storeGroupId),
    );

  return {
    catalogItemId: item.id,
    itemName: item.name,
    currency,
    receiptCount: receiptIds.size,
    lineCount: rows.length,
    spendMinor: storeResults.reduce((sum, store) => sum + store.spendMinor, 0),
    stores: storeResults,
  };
}

function toStorePrices(store: StoreAccumulator): ItemStorePrices {
  const families = PRICE_FAMILY_VALUES.flatMap((name) => {
    const family = store.families.get(name);
    return family ? [toFamilyPrices(family)] : [];
  });

  return {
    storeGroupId: store.storeGroupId,
    storeName: store.storeName,
    lineCount: store.lineCount,
    spendMinor: store.spendMinor,
    lastPaidMinor: store.lastPaidMinor,
    lastPaidAt: store.lastPaidAt,
    lastReceiptId: store.lastReceiptId,
    families,
  };
}

function toFamilyPrices(family: FamilyAccumulator): ItemPriceFamily {
  return {
    family: family.family,
    unit: family.unit,
    lineCount: family.history.length,
    lastUnitPriceMinor: family.lastUnitPriceMinor,
    minUnitPriceMinor: family.minUnitPriceMinor,
    maxUnitPriceMinor: family.maxUnitPriceMinor,
    trend: trendOf(family.history),
    history: family.history,
  };
}

/**
 * The direction between the most recent point and the newest point from an
 * earlier receipt. Two variants bought on the same trip are two prices at one
 * time, not a movement over time, so they never make a trend by themselves.
 */
function trendOf(history: readonly ItemPricePoint[]): PriceTrend {
  const last = history.at(-1);
  if (!last) return 'unknown';
  const previous = [...history]
    .reverse()
    .find((point) => point.receiptCreatedAt < last.receiptCreatedAt);
  if (!previous) return 'unknown';
  if (last.normalizedUnitPriceMinor > previous.normalizedUnitPriceMinor) {
    return 'up';
  }
  if (last.normalizedUnitPriceMinor < previous.normalizedUnitPriceMinor) {
    return 'down';
  }
  return 'flat';
}
