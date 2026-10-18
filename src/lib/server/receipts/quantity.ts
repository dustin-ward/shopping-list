/**
 * Quantity forms as receipts print them (plan §6, "item lines").
 *
 * Only idioms whose meaning is certain are read: a count with a unit price
 * (`2 @ 1.50`), a multi-buy (`2 FOR 4.00`), a scale weight (`2.15LB @ 0.59/LB`,
 * `1.5 KG`), and an explicit `QTY n`. A package size (`6CT`, `8OZ`, `1L`) is a
 * size, not a purchase quantity, so it stays in the name and the quantity
 * fields stay empty — quantity text is never silently invented. Whatever is
 * read is kept verbatim in `text`; the unit is filled in only when it maps onto
 * the canonical set.
 */

import { parseMoneyMinor } from './money';

export type CanonicalQuantityUnit =
  'lb' | 'kg' | 'oz' | 'g' | 'l' | 'ml' | 'ea';

export type QuantityReading = {
  real: number;
  /** The printed indicator, verbatim. */
  text: string;
  /** Canonical unit when confident; `null` when the printed unit is not one. */
  unit: CanonicalQuantityUnit | null;
  /** Unit price, when the form states one (`2 @ 1.50`). */
  unitPriceMinor: number | null;
  /** Extended price, when the form states one (`2 FOR 4.00`). */
  totalPriceMinor: number | null;
  /** The printed name with the indicator removed. */
  name: string;
};

const UNIT_WORDS: Record<string, CanonicalQuantityUnit> = {
  lb: 'lb',
  lbs: 'lb',
  pound: 'lb',
  pounds: 'lb',
  kg: 'kg',
  kgs: 'kg',
  kilo: 'kg',
  kilos: 'kg',
  oz: 'oz',
  ounce: 'oz',
  ounces: 'oz',
  g: 'g',
  gr: 'g',
  gram: 'g',
  grams: 'g',
  l: 'l',
  ltr: 'l',
  litre: 'l',
  liter: 'l',
  liters: 'l',
  litres: 'l',
  ml: 'ml',
  mls: 'ml',
  ea: 'ea',
  each: 'ea',
  ct: 'ea',
  count: 'ea',
  pk: 'ea',
  pack: 'ea',
};

/** Map a printed unit word onto the canonical set, or `null` when it is not one. */
export function canonicalUnit(word: string): CanonicalQuantityUnit | null {
  return UNIT_WORDS[word.trim().toLowerCase()] ?? null;
}

const UNIT = String.raw`(?:LB|LBS|POUNDS?|KG|KGS|KILOS?|OZ|OUNCES?|GRAMS?|GR|G|ML|MLS|LTR|LITRES?|LITERS?|L|EA|EACH|CT|COUNT|PK|PACK)`;
const AMOUNT = String.raw`\$?\d[\d,]*\.\d{2}`;

/** Printed forms, most specific first. The first match wins. */
const FORMS: {
  pattern: RegExp;
  read: (match: RegExpMatchArray) => Omit<QuantityReading, 'name'>;
}[] = [
  {
    // 2.50LB @ 4.99/LB   /   2 @ 1.50   /   2 X 0.75   /   2 BOX @ 3.00
    // The unit word is read even when it is not one we can canonically name:
    // the count and the unit price are still certain.
    pattern: new RegExp(
      String.raw`(\d+(?:\.\d+)?)\s*([A-Za-z]{1,6})?\s*(?:@|X)\s*(${AMOUNT})\s*(?:/\s*([A-Za-z]{1,6}))?`,
      'iu',
    ),
    read: (match) => {
      const [, quantity = '', unitWord, amount = '', perWord] = match;
      const unit = unitWord
        ? canonicalUnit(unitWord)
        : (canonicalUnit(perWord ?? '') ?? 'ea');
      return {
        real: Number(quantity),
        text: match[0].trim(),
        unit,
        unitPriceMinor: parseMoneyMinor(amount),
        totalPriceMinor: null,
      };
    },
  },
  {
    // 2 FOR 4.00
    pattern: new RegExp(String.raw`(\d+(?:\.\d+)?)\s*FOR\s*(${AMOUNT})`, 'iu'),
    read: (match) => ({
      real: Number(match[1]),
      text: match[0].trim(),
      unit: 'ea',
      unitPriceMinor: null,
      totalPriceMinor: parseMoneyMinor(match[2] ?? ''),
    }),
  },
  {
    // QTY 2   /   QTY 2 LB
    pattern: new RegExp(
      String.raw`\bQTY\.?\s*(\d+(?:\.\d+)?)\s*([A-Za-z]{1,6})?`,
      'iu',
    ),
    read: (match) => ({
      real: Number(match[1]),
      text: match[0].trim(),
      unit: match[2] ? canonicalUnit(match[2]) : 'ea',
      unitPriceMinor: null,
      totalPriceMinor: null,
    }),
  },
  {
    // 6 EA   /   2 EACH
    pattern: new RegExp(String.raw`(\d+(?:\.\d+)?)\s*(EA|EACH)\b`, 'iu'),
    read: (match) => ({
      real: Number(match[1]),
      text: match[0].trim(),
      unit: 'ea',
      unitPriceMinor: null,
      totalPriceMinor: null,
    }),
  },
  {
    // 2.15LB   /   1.5 KG — a decimal is a scale reading, not a package size.
    pattern: new RegExp(String.raw`(\d+\.\d+)\s*(${UNIT})\b`, 'iu'),
    read: (match) => ({
      real: Number(match[1]),
      text: match[0].trim(),
      unit: match[2] ? canonicalUnit(match[2]) : null,
      unitPriceMinor: null,
      totalPriceMinor: null,
    }),
  },
];

/**
 * Read the quantity a printed name carries, or `null` when it carries none we
 * are sure about.
 */
export function readQuantity(printedName: string): QuantityReading | null {
  const text = printedName.trim();
  if (!text) return null;

  for (const form of FORMS) {
    const match = text.match(form.pattern);
    if (!match) continue;
    return { ...form.read(match), name: stripIndicator(text, match[0]) };
  }
  return null;
}

/** Remove the matched indicator and tidy the leftover separators. */
function stripIndicator(text: string, indicator: string): string {
  return text
    .replace(indicator, ' ')
    .replace(/(?:^|[\s@xX*/-])+[-,]+(?=\s|$)/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
    .replace(/^[\s@xX*/-]+|[\s@xX*/-]+$/gu, '')
    .trim();
}
