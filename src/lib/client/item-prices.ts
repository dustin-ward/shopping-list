/**
 * The price sheet's client half (ticket 21; plan §10 "Item detail entry
 * points", §13 "R3 — price collation"): what one item's committed prices read
 * like on screen, and which sentence the add form whispers.
 *
 * The server already answered the hard questions in ticket 20 — which lines
 * count, how units normalize inside one family, what is "last paid". Nothing
 * here re-aggregates: this module only turns that answer into geometry
 * (sparkline points), household time ("last week"), and words.
 */

import { ApiError, requestJson } from './api';
import { formatMoney } from './money';
import type { ItemPrices, PriceBaseUnit, PriceTrend } from '../shared/schemas';

/** The sparkline's drawing box, in the SVG unit system the sheet renders. */
export const SPARKLINE_WIDTH = 120;
export const SPARKLINE_HEIGHT = 32;
export const SPARKLINE_PADDING = 3;

const DAY_MS = 86_400_000;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** One trend as the sheet says it: a direction glyph and a plain sentence. */
export type TrendReading = {
  arrow: '↑' | '↓' | '→' | '·';
  label: string;
};

export function trendReading(trend: PriceTrend): TrendReading {
  switch (trend) {
    case 'up':
      return { arrow: '↑', label: 'Up from last time' };
    case 'down':
      return { arrow: '↓', label: 'Down from last time' };
    case 'flat':
      return { arrow: '→', label: 'No change from last time' };
    default:
      return { arrow: '·', label: 'Not enough history to trend' };
  }
}

/**
 * The family's base unit as a price suffix. The number is meaningless without
 * it: `$4.50` per what? Only the unit ticket 20 normalized to is ever named, so
 * a pound price never reads as an each price.
 */
export function perUnitLabel(unit: PriceBaseUnit): string {
  return `per ${unit}`;
}

export type Sparkline = {
  /** The polyline's `points` attribute; empty when there is nothing to draw. */
  points: string;
  /** The newest point, so the sheet can mark it without re-deriving the scale. */
  last: { x: number; y: number } | null;
};

/** One unit price at the moment its receipt was recorded. */
export type SparklineSample = { value: number; at: string };

/**
 * Draw a family's normalized prices oldest first, spaced by the time each was
 * recorded so a long gap looks like a long gap. Variants bought on one trip
 * share an instant and stack vertically rather than pretending to be movement.
 * Equal prices share the middle line instead of dividing by a zero range, and a
 * single price sits in the centre as one dot.
 */
export function sparkline(
  samples: readonly SparklineSample[],
  width: number = SPARKLINE_WIDTH,
  height: number = SPARKLINE_HEIGHT,
  padding: number = SPARKLINE_PADDING,
): Sparkline {
  if (samples.length === 0) return { points: '', last: null };

  const values = samples.map((sample) => sample.value);
  const times = samples.map((sample) => Date.parse(sample.at));
  const timed = times.every(Number.isFinite);
  const firstTime = Math.min(...times);
  const lastTime = Math.max(...times);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const span = maximum - minimum;
  const innerWidth = width - padding * 2;
  const innerHeight = height - padding * 2;
  const yOf = (value: number): number =>
    span === 0
      ? height / 2
      : padding + ((maximum - value) / span) * innerHeight;
  const xOf = (index: number): number => {
    if (timed && lastTime > firstTime) {
      return (
        padding +
        ((times[index]! - firstTime) / (lastTime - firstTime)) * innerWidth
      );
    }
    if (timed || samples.length === 1) return width / 2;
    return padding + (index / (samples.length - 1)) * innerWidth;
  };

  const coordinates = values.map((value, index) => ({
    x: round(xOf(index)),
    y: round(yOf(value)),
  }));

  return {
    points: coordinates
      .map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`)
      .join(' '),
    last: coordinates.at(-1) ?? null,
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function startOfDay(date: Date): number {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

/**
 * When a committed price was recorded, in the terms a household uses. A future
 * client clock reads "today" rather than inventing a lead time; dates older than
 * two months are named exactly, because "2 months ago" stops helping.
 */
export function lastPaidWhen(iso: string, now: Date): string {
  const paidAt = new Date(iso);
  if (Number.isNaN(paidAt.getTime())) return 'recently';

  const days = Math.round((startOfDay(now) - startOfDay(paidAt)) / DAY_MS);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  if (days < 28) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 60) return 'last month';

  const sameYear = paidAt.getFullYear() === now.getFullYear();
  const date = `${MONTHS[paidAt.getMonth()]} ${paidAt.getDate()}`;
  return `on ${sameYear ? date : `${date}, ${paidAt.getFullYear()}`}`;
}

/**
 * The add form's nudge ("$3.49 last week at Hen House"), or `null` when the item
 * has no committed amount to name. The newest store that actually recorded an
 * amount wins: a cleared total is not a price to quote back.
 */
export function pricesNudge(prices: ItemPrices, now: Date): string | null {
  const latest = [...prices.stores]
    .filter((store) => store.lastPaidMinor !== null)
    .sort((left, right) => right.lastPaidAt.localeCompare(left.lastPaidAt))[0];
  if (!latest || latest.lastPaidMinor === null) return null;

  return `${formatMoney(latest.lastPaidMinor, prices.currency)} ${lastPaidWhen(
    latest.lastPaidAt,
    now,
  )} at ${latest.storeName}`;
}

/** One sentence for every refusal the price read can meet. */
export function pricesErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'Prices are unavailable. Try again.';
  }
  if (error.code === 'NOT_FOUND') {
    return 'That item is no longer in the item list — close this sheet and refresh.';
  }
  return error.message;
}

/** The item's price history; fetched on demand, never part of the snapshot. */
export function fetchItemPrices(catalogItemId: string): Promise<ItemPrices> {
  return requestJson<ItemPrices>(`/api/items/${catalogItemId}/prices`);
}
