/**
 * Money hygiene for printed receipt amounts (plan §6, "money hygiene").
 *
 * Every amount is read into integer minor units, the only representation the
 * database stores. A token is read only when it is unambiguously an amount:
 * commas as thousands separators, up to two decimal places, an optional `$`,
 * and a minus on either end (thermal printers put it after the digits). Tokens
 * that could be read two ways — three decimal-like groups, three decimals, no
 * decimals at all — are refused rather than guessed at, so the caller can leave
 * the printed text verbatim.
 */

/**
 * A printed amount: `3.49`, `1,234.56`, `1234.56`, `$3.49`, `-1.50`, `1.00-`.
 * Requiring exactly two decimals is what rejects `3.499`, and requiring at most
 * one decimal group is what rejects `1.234.56`; a long whole part is a normal
 * four-figure total, read the same whether or not it prints separators.
 */
const PRINTED_AMOUNT = /^\$?\d+(?:,\d{3})*\.\d{2}$/u;
const LEADING_MINUS = /^-/u;
const TRAILING_MINUS = /-$/u;

/**
 * Read one printed token as minor units, or `null` when it is not
 * unambiguously an amount.
 *
 * OCR leaves three kinds of noise on an otherwise clear amount, and each is
 * repaired only when the result is still unambiguous: a space dropped into the
 * decimal (`86. 21`), a comma used as the decimal mark (`12,52`), and the
 * single tax flag a receipt prints beside a price (`3.49 P`). Anything that
 * could still be read two ways stays refused.
 */
export function parseMoneyMinor(token: string): number | null {
  let text = token.trim();
  if (text.startsWith('$')) text = text.slice(1);
  const negative = LEADING_MINUS.test(text) || TRAILING_MINUS.test(text);
  text = text
    .replace(LEADING_MINUS, '')
    .replace(TRAILING_MINUS, '')
    .replace(/^\$/u, '');
  // Whitespace around a decimal or thousands separator is OCR noise; keep the
  // digits together so `86. 21` reads as `86.21` without inventing a decimal.
  text = text.replace(/\s*([.,])\s*/gu, '$1');
  // A single trailing tax flag (`P`, `T`, `F`, `N`) is printed against the
  // amount; two letters (`2.15LB`) or a unit (`4.99/LB`) are not.
  text = text.replace(/\s*[PTFN]$/u, '');
  // Thermal printers sometimes leave a trailing separator after the cents.
  text = text.replace(/[.,]$/u, '');
  // A single comma with exactly two digits after it is a decimal mark, not a
  // thousands separator; a three-digit group stays refused as ambiguous.
  if (!text.includes('.') && /^\d+,\d{2}$/u.test(text)) {
    text = text.replace(',', '.');
  }
  if (!PRINTED_AMOUNT.test(text)) return null;

  const [whole = '', cents = ''] = text.replace(/[$,]/gu, '').split('.');
  const minor = Number(whole) * 100 + Number(cents);
  return negative ? -minor : minor;
}

/** Whether a token is money the parser is willing to read. */
export function isMoneyToken(token: string): boolean {
  return parseMoneyMinor(token) !== null;
}

/** Render minor units the way a receipt prints them, for warnings and review. */
export function formatMinor(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const absolute = Math.abs(minor);
  return `${sign}${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}
