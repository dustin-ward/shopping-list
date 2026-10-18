/** The currency the receipt surfaces fall back to when a receipt has none. */
const DEFAULT_CURRENCY = 'USD';

/** Money as the receipt's own currency; `$3.49` for USD minor units. */
export function formatMoney(minor: number, currency: string | null): string {
  return new Intl.NumberFormat([], {
    style: 'currency',
    currency: currency ?? DEFAULT_CURRENCY,
  }).format(minor / 100);
}
