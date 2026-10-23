/** The currency the receipt surfaces fall back to when a receipt has none. */
const DEFAULT_CURRENCY = 'USD';

/** Money as the receipt's own currency; `$3.49` for USD minor units. */
export function formatMoney(minor: number, currency: string | null): string {
  return new Intl.NumberFormat([], {
    style: 'currency',
    currency: currency ?? DEFAULT_CURRENCY,
  }).format(minor / 100);
}

/**
 * A review edit's price field as it is typed: `3.49`, `1,234.56`, `$3.49`,
 * `-1.50` (coupon lines are negative). Amounts round-trip through minor units,
 * so a value that cannot be read exactly — three decimals, a stray character —
 * is refused rather than silently rounded. Only a leading or trailing minus and
 * a leading `$` are recognized, so a misplaced one is a typo the reviewer sees
 * rather than money the app quietly invents.
 */
export function parseMoneyInput(text: string): number | null {
  let value = text.trim();
  if (!value) return null;
  value = value.replace(/^\$/u, '');
  const negative = value.startsWith('-') || value.endsWith('-');
  value = value.replace(/^-|-$/gu, '').replace(/^\$/u, '');
  // Commas are thousands separators, never decimal ones.
  if (!/^\d+(?:,\d{3})*(?:\.\d{1,2})?$/u.test(value)) return null;

  const [whole = '', fraction = ''] = value.replace(/,/gu, '').split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return negative ? -minor : minor;
}

/** Minor units as a price field holds them; an empty field for `null`. */
export function moneyInputValue(minor: number | null): string {
  if (minor === null) return '';
  const sign = minor < 0 ? '-' : '';
  const absolute = Math.abs(minor);
  return `${sign}${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}
