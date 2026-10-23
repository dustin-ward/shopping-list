/**
 * The heuristic parser: raw sidecar JSON in, `receipt_lines` rows out (plan §6).
 *
 * The pipeline is geometry first, meaning second:
 *
 * 1. **Zoning** — lines a `Page-Header`/`Page-Footer` block covers are parked.
 * 2. **Rows** — boxes that share a printed row are reconstructed into one row.
 * 3. **Columns** — the modal right edge of amount-shaped tokens is the price
 *    column; a row's trailing amount is its price only while it sits there.
 * 4. **Routing** — subtotal/tax/total/change/tender/discount keywords (matched
 *    fuzzily, so an OCR dropout survives) decide footer rows and the receipt's
 *    totals; the rest of the body is item chunks.
 * 5. **Money hygiene** — amounts become integer minor units, or stay verbatim
 *    with a warning. `Σ(item totals) − subtotal` is the delta the review UI
 *    warns about above max($0.05, 1% of total); it never blocks.
 *
 * Nothing is ever silently dropped or guessed: every OCR line lands in exactly
 * one row (`sourceLineIndexes`), parked rows are persisted, and unreadable
 * text stays as printed.
 */

import { receiptTotals } from '../../shared/receipt-totals';
import {
  collapse,
  detectPriceColumns,
  groupRows,
  readOcrLines,
  rowTextWithoutAmount,
  splitRowPrice,
  unreadableAmount,
  type LayoutRow,
  type OcrLine,
  type PriceColumn,
} from './indra-layout';
import { formatMinor, parseMoneyMinor } from './money';
import { readQuantity, type CanonicalQuantityUnit } from './quantity';

/**
 * Bumped whenever the parser's output changes shape or meaning; the receipt
 * keeps its raw `ocr_json` so any version can be re-derived later.
 */
export const RECEIPT_PARSE_VERSION = 1;

/** How many unreadable amounts and low-confidence notes a warning list names. */
const MAX_NAMED_WARNINGS = 5;

/** A confidence below this is worth telling the reviewer about. */
const LOW_CONFIDENCE = 0.6;

/**
 * The warning the parser emits when no price column was detected. Exported so
 * the fallback tier's quality check names the same condition instead of
 * matching on a copied string.
 */
export const NO_PRICE_COLUMN_WARNING =
  'no price column found; prices were read line by line';

/**
 * How long both words must be for a one-edit fuzzy keyword match. Below this a
 * single edit is too vague to mean a mangled keyword (`CAT` is one edit from
 * `VAT`), and printed names are full of three-letter words.
 */
const FUZZY_MATCH_MIN_LENGTH = 4;

export type ParsedReceiptLine = {
  /** Indexes into the flattened OCR lines this row was reconstructed from. */
  sourceLineIndexes: number[];
  rawText: string;
  parsedName: string | null;
  quantityReal: number | null;
  quantityText: string | null;
  quantityUnit: CanonicalQuantityUnit | null;
  unitPriceMinor: number | null;
  totalPriceMinor: number | null;
  isItemChunk: boolean;
  confidence: number | null;
};

export type ParsedReceipt = {
  parseVersion: number;
  lines: ParsedReceiptLine[];
  subtotalMinor: number | null;
  taxMinor: number | null;
  totalMinor: number | null;
  /** `Σ(item totals) − subtotal` (the receipt total when there is no subtotal). */
  deltaMinor: number | null;
  warnings: string[];
};

type FooterRoute =
  'subtotal' | 'tax' | 'total' | 'change' | 'tender' | 'adjustment';

/**
 * Footer vocabulary, checked in this order. Keywords are matched as word runs
 * with a Levenshtein budget of one on words of at least
 * `FUZZY_MATCH_MIN_LENGTH`, which is how `TOTA1` and `ТАX` (a Cyrillic Т)
 * still route after OCR has dropped or mangled a letter.
 */
const FOOTER_ROUTES: { route: FooterRoute; words: string[][] }[] = [
  {
    route: 'adjustment',
    words: [
      ['coupon'],
      ['cpn'],
      ['discount'],
      ['savings'],
      ['saved'],
      ['deposit'],
      ['refund'],
      ['rebate'],
    ],
  },
  {
    route: 'subtotal',
    words: [
      ['subtotal'],
      ['sub', 'total'],
      ['sub', 'total', 'amount'],
      ['purchase'],
    ],
  },
  {
    route: 'tax',
    words: [
      ['tax'],
      ['taxes'],
      ['vat'],
      ['hst'],
      ['gst'],
      ['pst'],
      ['sales', 'tax'],
      ['tax', 'amount'],
    ],
  },
  {
    route: 'total',
    words: [
      ['total'],
      ['total', 'due'],
      ['total', 'amount'],
      ['amount', 'due'],
      ['balance', 'due'],
    ],
  },
  {
    route: 'change',
    words: [['change'], ['cash', 'back']],
  },
  {
    route: 'tender',
    words: [
      ['tender'],
      ['tendered'],
      ['visa'],
      ['mastercard'],
      ['amex'],
      ['discover'],
      ['debit'],
      ['credit'],
      ['cash'],
      ['ebt'],
      ['check'],
      ['card'],
      ['tip'],
      ['gratuity'],
      ['account'],
      ['approved'],
      ['approval'],
      ['payment'],
      ['transaction'],
      ['auth'],
      ['number'],
      ['order'],
      ['ordered'],
      ['thank', 'you'],
    ],
  },
];

/** Parse one raw OCR payload into rows, receipt totals, the delta and warnings. */
export function parseReceiptOcr(raw: string): ParsedReceipt {
  const read = readOcrLines(raw);
  if (!read) {
    return emptyParse(['the OCR payload could not be read']);
  }

  const emptyLines = read.lines.filter((line) => !line.text.trim());
  const lines = read.lines.filter((line) => Boolean(line.text.trim()));
  const rows = groupRows(lines);
  const { columns, found: columnFound } = detectPriceColumns(rows);

  const warnings: string[] = [];
  if (
    !columnFound &&
    rows.some((row) => splitRowPrice(row, columns, false).priceMinor !== null)
  ) {
    warnings.push(NO_PRICE_COLUMN_WARNING);
  }

  const parsed: ParsedReceiptLine[] = [];
  let subtotalMinor: number | null = null;
  let taxMinor: number | null = null;
  let totalMinor: number | null = null;
  let itemRegionStarted = false;
  let pending: LayoutRow[] = [];
  // Rows above the first priced item are either the receipt header or the
  // first item's name. Hold them until the first price arrives, then keep only
  // the name line and park the rest.
  let preItem: LayoutRow[] = [];
  const unreadable: string[] = [];
  let mismatchCount = 0;
  let lowConfidenceCount = 0;

  const flushPending = (): void => {
    for (const row of pending)
      parsed.push(parkedRow(row, columns, columnFound));
    pending = [];
  };

  const flushPreItem = (): void => {
    for (const row of preItem)
      parsed.push(parkedRow(row, columns, columnFound));
    preItem = [];
  };

  for (const row of rows) {
    let price = splitRowPrice(row, columns, columnFound);
    // A regular-price line sometimes carries the item's actual total in an
    // intermediate column (`Reg 2.99 1.0 1.79`). When the right margin is
    // unreadable, the last readable amount on the line is that total.
    if (
      price.priceMinor === null &&
      pending.length > 0 &&
      isPriceMetadata(fullText(row))
    ) {
      const fallback = lastMoneyToken(fullText(row));
      if (fallback !== null) price = { ...price, priceMinor: fallback };
    }
    const route = routeFooterRow(price.text);
    const amount = unreadableAmountOf(row);

    if (route && route !== 'adjustment') {
      flushPending();
      flushPreItem();
      const parked = parkedRow(row, columns, columnFound);
      parsed.push(parked);
      itemRegionStarted = true;
      if (route === 'subtotal') subtotalMinor = parked.totalPriceMinor;
      else if (route === 'tax') taxMinor = parked.totalPriceMinor;
      else if (route === 'total') totalMinor = parked.totalPriceMinor;
      continue;
    }

    if (route === 'adjustment') {
      flushPending();
      flushPreItem();
      parsed.push(parkedRow(row, columns, columnFound));
      continue;
    }

    if (row.zone === 'header' || row.zone === 'footer') {
      flushPending();
      flushPreItem();
      parsed.push(parkedRow(row, columns, columnFound));
      continue;
    }

    // Department headers (`22-DAIRY`, `34-BAKERY`) are printed between items,
    // not as part of the next item's name.
    if (isDepartmentHeader(row)) {
      flushPending();
      flushPreItem();
      parsed.push(parkedRow(row, columns, columnFound));
      continue;
    }

    if (price.priceMinor === null) {
      if (amount) {
        unreadable.push(`could not read the amount on "${fullText(row)}"`);
        if (pending.length > 0 && isAmountTailRow(row)) {
          // The buffered name is the item and this row carries its unreadable
          // amount. Keep the item with an unknown price so the amount line
          // cannot be folded into the next item's name.
          const pendingName = pending.map(fullText).join(' ');
          if (looksLikeItemName(pendingName)) {
            if (!itemRegionStarted) flushPreItem();
            const item = itemRow(
              pending.at(-1)!,
              { text: '', priceMinor: null },
              pending.slice(0, -1),
              columnFound,
            );
            pending = [];
            parsed.push(item.line);
            if ((item.line.confidence ?? 1) < LOW_CONFIDENCE) {
              lowConfidenceCount += 1;
            }
          } else {
            flushPending();
          }
          parsed.push(parkedRow(row, columns, columnFound));
          continue;
        }

        if (looksLikeItemName(fullText(row))) {
          // The row names its own item (a leading product code, or a full
          // product name); keep it with an unknown price.
          if (!itemRegionStarted) flushPreItem();
          const item = itemRow(row, price, [], columnFound);
          parsed.push(item.line);
          if ((item.line.confidence ?? 1) < LOW_CONFIDENCE) {
            lowConfidenceCount += 1;
          }
          continue;
        }

        // A labelled footer line with an amount-shaped code: park it after
        // the buffered name rows so reading order is preserved.
        flushPending();
        parsed.push(parkedRow(row, columns, columnFound));
        continue;
      }

      if (itemRegionStarted) pending.push(row);
      else preItem.push(row);
      continue;
    }

    if (!itemRegionStarted) {
      const nameFromBuffer =
        preItem.length > 0 &&
        (price.text.trim() === '' || isPriceMetadata(price.text));
      const bufferedName = nameFromBuffer ? preItem.at(-1)! : null;
      for (const buffered of nameFromBuffer ? preItem.slice(0, -1) : preItem) {
        parsed.push(parkedRow(buffered, columns, columnFound));
      }
      preItem = [];
      pending = bufferedName ? [bufferedName] : [];
    }

    const item = itemRow(row, price, pending, columnFound);
    pending = [];
    itemRegionStarted = true;
    parsed.push(item.line);
    if (item.qtyMismatch) mismatchCount += 1;
    if ((item.line.confidence ?? 1) < LOW_CONFIDENCE) lowConfidenceCount += 1;
  }
  flushPending();
  flushPreItem();

  // A tax line can be mangled past keyword matching (`cuaтorat`). When the
  // receipt prints both SUBTOTAL and TOTAL, the row between them whose amount
  // is exactly the difference is the tax, not an item.
  if (taxMinor === null && subtotalMinor !== null && totalMinor !== null) {
    const difference = totalMinor - subtotalMinor;
    const subtotalAt = parsed.findIndex(
      (line) =>
        !line.isItemChunk && routeFooterRow(line.rawText) === 'subtotal',
    );
    const totalAt = parsed.findIndex(
      (line) => !line.isItemChunk && routeFooterRow(line.rawText) === 'total',
    );
    if (difference > 0 && subtotalAt >= 0 && totalAt > subtotalAt) {
      const taxAt = parsed.findIndex(
        (line, index) =>
          index > subtotalAt &&
          index < totalAt &&
          line.isItemChunk &&
          line.totalPriceMinor === difference,
      );
      if (taxAt >= 0) {
        const line = parsed[taxAt]!;
        parsed[taxAt] = {
          ...line,
          parsedName: null,
          quantityReal: null,
          quantityText: null,
          quantityUnit: null,
          unitPriceMinor: null,
          isItemChunk: false,
        };
        taxMinor = difference;
      }
    }
  }

  warnings.push(
    ...unreadable.slice(0, MAX_NAMED_WARNINGS),
    ...(unreadable.length > MAX_NAMED_WARNINGS
      ? [
          `and ${unreadable.length - MAX_NAMED_WARNINGS} more unreadable amounts`,
        ]
      : []),
  );
  if (emptyLines.length > 0) {
    warnings.push(`${emptyLines.length} OCR lines carried no text`);
  }
  if (subtotalMinor === null && totalMinor === null) {
    warnings.push('no subtotal or total found on the receipt');
  }
  if (lowConfidenceCount > 0) {
    warnings.push(
      `${lowConfidenceCount} lines were read at low confidence (under ${Math.round(
        LOW_CONFIDENCE * 100,
      )}%)`,
    );
  }
  if (mismatchCount > 0) {
    warnings.push(
      `${mismatchCount} item lines do not multiply out (quantity x unit price)`,
    );
  }

  // One arithmetic for both the recorded warning and the review strip.
  const totals = receiptTotals({
    lines: parsed,
    subtotalMinor,
    taxMinor,
    totalMinor,
  });
  const { deltaMinor } = totals;
  if (deltaMinor !== null && totals.itemsMinor !== null && totals.deltaWarns) {
    warnings.push(
      `the item lines total ${formatMinor(totals.itemsMinor)} but ${
        totals.deltaReference === 'subtotal' ? 'SUBTOTAL' : 'TOTAL'
      } reads ${formatMinor((subtotalMinor ?? totalMinor) as number)} (delta ${formatMinor(
        Math.abs(deltaMinor),
      )})`,
    );
  }

  return {
    parseVersion: RECEIPT_PARSE_VERSION,
    lines: parsed,
    subtotalMinor,
    taxMinor,
    totalMinor,
    deltaMinor,
    warnings,
  };
}

function emptyParse(warnings: string[]): ParsedReceipt {
  return {
    parseVersion: RECEIPT_PARSE_VERSION,
    lines: [],
    subtotalMinor: null,
    taxMinor: null,
    totalMinor: null,
    deltaMinor: null,
    warnings,
  };
}

function parkedRow(
  row: LayoutRow,
  columns: PriceColumn[],
  columnFound: boolean,
): ParsedReceiptLine {
  const price = splitRowPrice(row, columns, columnFound);
  return {
    sourceLineIndexes: row.lines.map(({ index }) => index),
    rawText: price.priceMinor === null ? fullText(row) : price.text,
    parsedName: null,
    quantityReal: null,
    quantityText: null,
    quantityUnit: null,
    unitPriceMinor: null,
    totalPriceMinor: price.priceMinor,
    isItemChunk: false,
    confidence: round2(meanConfidence(row.lines)),
  };
}

function itemRow(
  row: LayoutRow,
  price: { text: string; priceMinor: number | null },
  pending: LayoutRow[],
  columnFound: boolean,
): { line: ParsedReceiptLine; qtyMismatch: boolean } {
  // Price metadata (`Reg 7.99`, `1.0 @ 2.99`) sits between the item name and
  // its total; it describes the price, not the product.
  const pendingName = pending
    .map(fullText)
    .filter((text) => !isPriceMetadata(text))
    .join(' ');
  const rowText =
    price.priceMinor === null ? rowTextWithoutAmount(row) : price.text;
  const rowName = isPriceMetadata(rowText) ? '' : rowText;
  const printedName = collapse(
    [pendingName, rowName].filter(Boolean).join(' '),
  );
  const quantity = readQuantity(printedName);
  const totalPriceMinor = price.priceMinor;
  const derivedUnit = deriveUnitPrice(quantity);

  let qtyMismatch = false;
  let confidence = meanConfidence([
    ...pending.flatMap((row) => row.lines),
    ...row.lines,
  ]);
  if (quantity && derivedUnit !== null && totalPriceMinor !== null) {
    const multiplied = Math.round(quantity.real * derivedUnit);
    if (multiplied !== totalPriceMinor) {
      qtyMismatch = true;
      confidence = round2(confidence * 0.8);
    }
  }
  // A price read without a column to place it in is worth a little less trust.
  if (!columnFound) confidence = round2(confidence * 0.9);

  return {
    line: {
      sourceLineIndexes: [
        ...pending.flatMap(({ lines }) => lines.map(({ index }) => index)),
        ...row.lines.map(({ index }) => index),
      ],
      rawText: printedName,
      parsedName: cleanItemName(quantity ? quantity.name : printedName) || null,
      quantityReal: quantity?.real ?? null,
      quantityText: quantity?.text ?? null,
      quantityUnit: quantity?.unit ?? null,
      unitPriceMinor: derivedUnit,
      totalPriceMinor,
      isItemChunk: true,
      confidence: round2(Math.min(1, confidence)),
    },
    qtyMismatch,
  };
}

/** The per-unit price: printed (`2 @ 1.50`), or stated by a multi-buy. */
function deriveUnitPrice(
  quantity: ReturnType<typeof readQuantity>,
): number | null {
  if (!quantity) return null;
  if (quantity.unitPriceMinor !== null) return quantity.unitPriceMinor;
  if (quantity.totalPriceMinor !== null && quantity.real > 0) {
    return Math.round(quantity.totalPriceMinor / quantity.real);
  }
  return null;
}

/** Route a printed row by keyword; `null` when it is ordinary content. */
function routeFooterRow(text: string): FooterRoute | null {
  // A percentage-off line is a discount, not an item; matching `off` as a
  // keyword alone would also catch product names.
  if (/\b\d+\s*%\s*off\b/iu.test(text)) return 'adjustment';
  // `Check #97` is a receipt number, not a payment by check.
  if (/^check\s*#/iu.test(text)) return null;

  const words = foldLookalikes(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (words.length === 0) return null;

  for (const { route, words: keyWords } of FOOTER_ROUTES) {
    for (const key of keyWords) {
      if (containsWordRun(words, key)) return route;
    }
  }
  return null;
}

/**
 * Fold the Cyrillic and Greek letters that look like Latin ones (`ТАX` for
 * `TAX`). OCR engines mix scripts on printed Latin text; the keywords are
 * Latin, so folding the lookalikes before matching is what lets a mangled
 * footer word still route.
 */
const LOOKALIKES: Record<string, string> = {
  А: 'A',
  В: 'B',
  Е: 'E',
  К: 'K',
  М: 'M',
  Н: 'H',
  О: 'O',
  Р: 'P',
  С: 'C',
  Т: 'T',
  У: 'Y',
  Х: 'X',
  І: 'I',
  Ѕ: 'S',
  а: 'a',
  в: 'b',
  е: 'e',
  і: 'i',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  ѕ: 's',
  Α: 'A',
  Β: 'B',
  Ε: 'E',
  Ζ: 'Z',
  Η: 'H',
  Ι: 'I',
  Κ: 'K',
  Μ: 'M',
  Ν: 'N',
  Ο: 'O',
  Ρ: 'P',
  Τ: 'T',
  Υ: 'Y',
  Χ: 'X',
  α: 'a',
  ο: 'o',
  ρ: 'p',
};

function foldLookalikes(text: string): string {
  return text.replace(
    /[\u0391-\u03c9\u0400-\u04ff]/gu,
    (letter) => LOOKALIKES[letter] ?? letter,
  );
}

/** Whether the row's words contain `key` (a run, each word within one edit). */
function containsWordRun(words: string[], key: string[]): boolean {
  for (let start = 0; start + key.length <= words.length; start += 1) {
    if (
      key.every((word, offset) => withinOneEdit(words[start + offset]!, word))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Words that differ by at most one insertion, deletion or substitution — but
 * only once each word is long enough for one edit to stay specific. Below four
 * characters a single edit reaches unrelated words (`CAT` is one edit from
 * `VAT`, `MAX` from `TAX`), and printed names are full of three-letter words.
 */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < FUZZY_MATCH_MIN_LENGTH || b.length < FUZZY_MATCH_MIN_LENGTH) {
    return false;
  }
  let edits = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function fullText(row: LayoutRow): string {
  return collapse(row.lines.map(({ text }) => text).join(' '));
}

/**
 * A grocery department heading is printed as a short `NN-NAME` row between
 * items (`22-DAIRY`, `34-BAKERY`). It is not part of the next item's name.
 */
function isDepartmentHeader(row: LayoutRow): boolean {
  const text = fullText(row);
  return text.length <= 40 && /^\d{1,2}\s*[-–]\s*[\p{L}\p{N}]/u.test(text);
}

/** A printed regular/unit price line, not a product name. */
function isPriceMetadata(text: string): boolean {
  return /^(?:reg(?:ular)?|was|now|sale|list)\b/iu.test(text);
}

/** The last readable amount printed on a line, or `null` when none is. */
function lastMoneyToken(text: string): number | null {
  const tokens = text.split(/\s+/u).filter(Boolean);
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const minor = parseMoneyMinor(tokens[index]!);
    if (minor !== null) return minor;
  }
  return null;
}

/**
 * Whether printed text names an item rather than a footer or an amount. A
 * leading product code (the long SKU grocery receipts print) or two long words
 * is enough; a single word or a bare amount is not.
 */
function looksLikeItemName(text: string): boolean {
  if (/^[^\p{L}]*\d{5,}/u.test(text)) return true;
  const longWords = text.match(/\p{L}{3,}/gu) ?? [];
  return longWords.length >= 2;
}

/**
 * Whether a row is only an amount, or a quantity prefix plus an amount. Such a
 * row can complete a buffered item name; a labelled row (`Payment I0 068742`)
 * cannot.
 */
function isAmountTailRow(row: LayoutRow): boolean {
  return !/\p{L}{3,}/u.test(rowTextWithoutAmount(row));
}

/**
 * Product codes (UPCs and SKUs) and the punctuation thermal printers leave
 * around a truncated name are not part of the item's name.
 */
function cleanItemName(text: string): string {
  return collapse(
    text.replace(/\b\d{6,}\b/gu, ' ').replace(/[\s:;,._|」§-]+$/u, ''),
  );
}

function unreadableAmountOf(row: LayoutRow): string | null {
  const amount = unreadableAmount(row);
  if (!amount) return null;
  // A separate amount box on the row is a price the OCR could not read.
  if (row.lines.length > 1) return amount;
  const name = rowTextWithoutAmount(row);
  // An amount-only row, or the amount line of an item name, is always a
  // printed price.
  if (!/\p{L}{3,}/u.test(name)) return amount;
  // A leading product code makes the row an item even with an unreadable
  // price.
  if (/^[^\p{L}]*\d{5,}/u.test(fullText(row))) return amount;
  // A bare integer on a labelled row (`Check #97`) is a number, not a price;
  // a token with separators or a currency symbol is money we failed to read.
  return /[.,$]/u.test(amount) ? amount : null;
}

function meanConfidence(lines: OcrLine[]): number {
  if (lines.length === 0) return 0;
  return lines.reduce((sum, line) => sum + line.conf, 0) / lines.length;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
