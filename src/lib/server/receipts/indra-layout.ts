/**
 * Geometry over the sidecar's line JSON (plan §6, "zoning" and "column
 * detection").
 *
 * Indra returns one box per detected run of text, so a printed row usually
 * arrives as two or more boxes: the printed name on the left and its amount at
 * the right margin. This module reconstructs printed rows from those boxes,
 * finds the price column(s), and splits a row into its name text and its
 * amount. It reads text verbatim and never guesses: a token that is not
 * unambiguously money stays in the row's text.
 */

import { isMoneyToken, parseMoneyMinor } from './money';

/** `[x0, y0, x1, y1]` in image pixels. */
export type Box = [number, number, number, number];

/** A page zone; header and footer zones are parked, never item lines. */
export type Zone = 'header' | 'body' | 'footer';

export type OcrLine = {
  /** Position in the flattened page's reading order — the no-loss receipt. */
  index: number;
  text: string;
  box: Box;
  conf: number;
  zone: Zone;
};

/** One printed row: every box that shares it, in reading order. */
export type LayoutRow = { lines: OcrLine[]; box: Box; zone: Zone };

export type PriceColumn = { rightEdge: number; tolerance: number };

export type RowPrice = {
  /** The row's printed text without the amount. */
  text: string;
  priceToken: string | null;
  priceMinor: number | null;
};

/**
 * Read the flattened lines out of a sidecar payload. Malformed pages, lines and
 * blocks are skipped rather than trusted — the raw payload is kept verbatim in
 * `ocr_json`, so nothing is lost by ignoring a shape we cannot read.
 */
export function readOcrLines(
  raw: string,
): { lines: OcrLine[]; pageWidth: number } | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  const pages = (payload as { pages?: unknown } | null)?.pages;
  if (!Array.isArray(pages)) return null;

  const lines: OcrLine[] = [];
  let pageWidth = 0;
  for (const page of pages) {
    const pageLines = (page as { lines?: unknown } | null)?.lines;
    const blocks = normaliseBlocks(
      (page as { blocks?: unknown } | null)?.blocks,
    );
    if (!Array.isArray(pageLines)) continue;
    for (const candidate of pageLines) {
      const line = normaliseLine(candidate, lines.length, blocks);
      if (!line) continue;
      pageWidth = Math.max(pageWidth, line.box[2]);
      lines.push(line);
    }
  }
  return { lines, pageWidth };
}

type NormalisedBlock = { label: string; bbox: Box };

function normaliseBlocks(blocks: unknown): NormalisedBlock[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((block) => {
    const candidate = block as { label?: unknown; bbox?: unknown };
    const box = toBox(candidate?.bbox);
    if (!box || typeof candidate?.label !== 'string') return [];
    return [{ label: candidate.label.toLowerCase(), bbox: box }];
  });
}

function normaliseLine(
  candidate: unknown,
  index: number,
  blocks: NormalisedBlock[],
): OcrLine | null {
  const line = candidate as { box?: unknown; text?: unknown; conf?: unknown };
  const box = toBox(line?.box);
  if (!box || typeof line?.text !== 'string') return null;
  return {
    index,
    text: line.text,
    box,
    conf: typeof line.conf === 'number' ? line.conf : 0,
    zone: zoneAt(box, blocks),
  };
}

function toBox(value: unknown): Box | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const numbers = value.slice(0, 4).map(Number);
  if (numbers.some((number) => !Number.isFinite(number))) return null;
  return [numbers[0]!, numbers[1]!, numbers[2]!, numbers[3]!];
}

/** The zone a block label puts a box in; unlabelled boxes are body text. */
function zoneAt(box: Box, blocks: NormalisedBlock[]): Zone {
  const x = (box[0] + box[2]) / 2;
  const y = (box[1] + box[3]) / 2;
  const covering = blocks
    .filter(({ bbox }) => contains(bbox, x, y))
    .sort((a, b) => area(a.bbox) - area(b.bbox))[0];
  if (!covering) return 'body';
  if (covering.label.includes('header')) return 'header';
  if (covering.label.includes('footer')) return 'footer';
  return 'body';
}

function contains(box: Box, x: number, y: number): boolean {
  return x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
}

function area(box: Box): number {
  return (box[2] - box[0]) * (box[3] - box[1]);
}

/**
 * Group lines into printed rows. Text boxes are grouped by vertical overlap as
 * before; amount boxes are then paired with those rows in reading order. A
 * photographed receipt is rarely level, so an amount can sit a line-height
 * below its label: pairing by monotonic vertical order tolerates that skew
 * without letting a tip amount drift onto the total row below it.
 */
export function groupRows(lines: OcrLine[]): LayoutRow[] {
  const amounts: OcrLine[] = [];
  const texts: OcrLine[] = [];
  for (const line of lines) {
    if (isAmountOnlyLine(line.text)) amounts.push(line);
    else texts.push(line);
  }

  const rows = groupTextRows(texts);
  const columns = detectStrongColumns(amounts.map((line) => line.box[2]));
  const paired = new Set<OcrLine>();
  for (const column of columns) {
    const candidates = amounts.filter(
      (line) =>
        !paired.has(line) &&
        Math.abs(line.box[2] - column.rightEdge) <= column.tolerance,
    );
    for (const [rowIndex, line] of pairAmounts(rows, candidates)) {
      addLineToRow(rows[rowIndex]!, line);
      paired.add(line);
    }
  }

  // Amounts outside the strong columns (a unit price or a discount in the
  // middle of the row) still belong to a printed row; join them by overlap, or
  // keep them as their own row when nothing shares their line.
  for (const line of amounts) {
    if (paired.has(line)) continue;
    const target = bestOverlappingRow(rows, line);
    if (target) addLineToRow(target, line);
    else
      rows.push({ lines: [line], box: [...line.box] as Box, zone: line.zone });
  }

  for (const row of rows) {
    row.lines.sort((a, b) => a.box[0] - b.box[0]);
    row.box = row.lines
      .map(({ box }) => box)
      .reduce((merged, box) => mergeBox(merged, box));
  }
  return rows.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
}

function groupTextRows(lines: OcrLine[]): LayoutRow[] {
  const ordered = [...lines].sort(
    (a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0],
  );
  const rows: LayoutRow[] = [];
  for (const line of ordered) {
    const current = rows.at(-1);
    if (current && sharesPrintedRow(current.box, line.box)) {
      current.lines.push(line);
      current.box = mergeBox(current.box, line.box);
      // A zone label wins over plain body text when a row straddles both.
      current.zone = current.zone === 'body' ? line.zone : current.zone;
      continue;
    }
    rows.push({ lines: [line], box: [...line.box] as Box, zone: line.zone });
  }
  return rows;
}

function addLineToRow(row: LayoutRow, line: OcrLine): void {
  row.lines.push(line);
  row.box = mergeBox(row.box, line.box);
  row.zone = row.zone === 'body' ? line.zone : row.zone;
}

function bestOverlappingRow(
  rows: LayoutRow[],
  line: OcrLine,
): LayoutRow | null {
  let best: LayoutRow | null = null;
  let bestOverlap = 0;
  for (const row of rows) {
    const overlap =
      Math.min(row.box[3], line.box[3]) - Math.max(row.box[1], line.box[1]);
    if (overlap > bestOverlap) {
      best = row;
      bestOverlap = overlap;
    }
  }
  return best;
}

/**
 * Pair amount lines with text rows in reading order. The dynamic program may
 * skip a row or an amount, so a receipt with unit prices between item rows
 * still pairs each total with the right label; a small penalty for an amount
 * printed above its label keeps skew from pulling a tip onto the total below.
 */
function pairAmounts(
  rows: LayoutRow[],
  amounts: OcrLine[],
): Map<number, OcrLine> {
  const assignments = new Map<number, OcrLine>();
  if (rows.length === 0 || amounts.length === 0) return assignments;

  const orderedRows = rows
    .map((row, index) => ({
      row,
      index,
      center: centerY(row.box),
      height: Math.max(1, row.box[3] - row.box[1]),
    }))
    .sort((a, b) => a.center - b.center);
  const orderedAmounts = [...amounts].sort(
    (a, b) => centerY(a.box) - centerY(b.box),
  );

  const heights = orderedRows.map(({ height }) => height).sort((a, b) => a - b);
  const gaps = orderedRows
    .slice(1)
    .map(({ center }, index) => center - orderedRows[index]!.center)
    .filter((gap) => gap > 0)
    .sort((a, b) => a - b);
  const lineHeight = median(heights) ?? 20;
  const rowGap = median(gaps) ?? lineHeight * 2;
  const maxDistance = Math.max(lineHeight * 1.5, rowGap * 0.8);
  const abovePenalty = lineHeight * 0.75;
  const skipCost = maxDistance + 1;

  const rowCount = orderedRows.length;
  const amountCount = orderedAmounts.length;
  const cost = Array.from({ length: rowCount + 1 }, () =>
    new Array<number>(amountCount + 1).fill(Number.POSITIVE_INFINITY),
  );
  const choice = Array.from({ length: rowCount + 1 }, () =>
    new Array<'row' | 'amount' | 'pair'>(amountCount + 1).fill('row'),
  );
  cost[0]![0] = 0;

  for (let i = 0; i <= rowCount; i += 1) {
    for (let j = 0; j <= amountCount; j += 1) {
      const current = cost[i]![j]!;
      if (!Number.isFinite(current)) continue;
      if (i < rowCount && current < cost[i + 1]![j]!) {
        cost[i + 1]![j] = current;
        choice[i + 1]![j] = 'row';
      }
      if (j < amountCount && current + skipCost < cost[i]![j + 1]!) {
        cost[i]![j + 1] = current + skipCost;
        choice[i]![j + 1] = 'amount';
      }
      if (i < rowCount && j < amountCount) {
        const row = orderedRows[i]!;
        const amount = orderedAmounts[j]!;
        const distance = Math.abs(centerY(amount.box) - row.center);
        if (distance <= maxDistance) {
          const penalty = centerY(amount.box) < row.center ? abovePenalty : 0;
          const paired = current + distance + penalty;
          if (paired < cost[i + 1]![j + 1]!) {
            cost[i + 1]![j + 1] = paired;
            choice[i + 1]![j + 1] = 'pair';
          }
        }
      }
    }
  }

  let i = rowCount;
  let j = amountCount;
  while (i > 0 || j > 0) {
    const step = choice[i]![j]!;
    if (step === 'pair') {
      assignments.set(orderedRows[i - 1]!.index, orderedAmounts[j - 1]!);
      i -= 1;
      j -= 1;
    } else if (step === 'amount') {
      j -= 1;
    } else {
      i -= 1;
    }
  }
  return assignments;
}

function centerY(box: Box): number {
  return (box[1] + box[3]) / 2;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1
    ? values[middle]!
    : (values[middle - 1]! + values[middle]!) / 2;
}

function sharesPrintedRow(a: Box, b: Box): boolean {
  const overlap = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (overlap <= 0) return false;
  const shortest = Math.min(a[3] - a[1], b[3] - b[1]);
  return shortest > 0 && overlap / shortest >= 0.5;
}

function mergeBox(a: Box, b: Box): Box {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
}

/**
 * Find the price column(s): the right edges that most amounts share. A receipt
 * prints its amounts flush at the margin, so the modal right edge is the
 * column; a second cluster is a second column (a two-column receipt). With
 * fewer than two agreeing rows there is no column to trust, and the caller
 * reads prices line by line instead.
 *
 * Columns far to the left of the rightmost one are intermediate prices (unit
 * prices, discounts), not item totals; keeping them would let a coupon amount
 * masquerade as an item price.
 */
export function detectPriceColumns(rows: LayoutRow[]): {
  columns: PriceColumn[];
  found: boolean;
} {
  const edges = rows
    .map((row) => trailingMoney(row)?.box[2])
    .filter((edge): edge is number => edge !== undefined);
  const columns = detectStrongColumns(edges);
  if (columns.length === 0) return { columns: [], found: false };

  const rightmost = columns.at(-1)!.rightEdge;
  const kept = columns.filter((column) => column.rightEdge >= rightmost * 0.8);
  return { columns: kept, found: kept.length > 0 };
}

/** Cluster amount right edges and keep the clusters at least two rows share. */
function detectStrongColumns(edges: number[]): PriceColumn[] {
  const sorted = [...edges].sort((a, b) => a - b);
  if (sorted.length === 0) return [];

  const tolerance = Math.max(4, 0.02 * (sorted.at(-1) ?? 0));
  const clusters: number[][] = [];
  for (const edge of sorted) {
    const current = clusters.at(-1);
    if (current && edge - (current.at(-1) ?? edge) <= tolerance)
      current.push(edge);
    else clusters.push([edge]);
  }

  return clusters
    .filter((cluster) => cluster.length >= 2)
    .map((cluster) => ({
      rightEdge: cluster.reduce((sum, edge) => sum + edge, 0) / cluster.length,
      tolerance,
    }))
    .sort((a, b) => a.rightEdge - b.rightEdge);
}

/** Split a row into its printed text and its amount, if it carries one. */
export function splitRowPrice(
  row: LayoutRow,
  columns: PriceColumn[],
  requireColumn: boolean,
): RowPrice {
  const money = trailingMoney(row);
  const text = row.lines.map(({ text: value }) => value).join(' ');
  if (!money)
    return { text: collapse(text), priceToken: null, priceMinor: null };

  const { line, token, minor: priceMinor } = money;
  if (priceMinor === null) {
    return { text: collapse(text), priceToken: null, priceMinor: null };
  }
  if (
    requireColumn &&
    !columns.some(
      (column) => Math.abs(line.box[2] - column.rightEdge) <= column.tolerance,
    )
  ) {
    return { text: collapse(text), priceToken: null, priceMinor: null };
  }

  const withoutAmount = row.lines
    .map(({ text: value }) =>
      value === line.text ? stripTrailingAmount(value, token) : value,
    )
    .join(' ');
  return {
    text: collapse(withoutAmount),
    priceToken: token,
    priceMinor,
  };
}

/**
 * A row's printed text with its trailing amount-shaped token removed, whether
 * or not that amount was readable. Used when an item's price is unreadable but
 * its name should still be kept.
 */
export function rowTextWithoutAmount(row: LayoutRow): string {
  const money = trailingMoney(row);
  if (!money) return collapse(row.lines.map(({ text }) => text).join(' '));
  return collapse(
    row.lines
      .map(({ text }) =>
        text === money.line.text
          ? stripTrailingAmount(text, money.token)
          : text,
      )
      .join(' '),
  );
}

/**
 * The trailing digits-shaped token of a row that is *not* readable money, e.g.
 * `1.234.56`. It is left verbatim in the row's text and reported instead of
 * being guessed at.
 */
export function unreadableAmount(row: LayoutRow): string | null {
  const money = trailingMoney(row);
  if (!money || money.minor !== null) return null;
  return money.token;
}

function trailingMoney(
  row: LayoutRow,
): { line: OcrLine; token: string; minor: number | null; box: Box } | null {
  if (row.lines.length === 0) return null;
  const line = [...row.lines].sort(
    (a, b) => b.box[2] - a.box[2] || b.box[0] - a.box[0],
  )[0]!;
  const token = trailingAmount(line.text);
  if (!token) return null;
  return { line, token, minor: parseMoneyMinor(token), box: line.box };
}

/**
 * The amount-shaped tail of a printed line. Most amounts are one token, but
 * OCR sometimes splits the decimal (`86. 21`) and receipts print a tax flag
 * after the cents (`3.49 P`); both are still one amount.
 */
function trailingAmount(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/u);
  const last = tokens.at(-1)!;
  if (tokens.length >= 2) {
    const combined = `${tokens.at(-2)!} ${last}`;
    // An OCR split decimal (`86. 21`) or a split unreadable amount
    // (`769. 329`) reads as one amount before the bare tail can be taken.
    if (isMoneyToken(combined) || looksNumeric(combined)) return combined;
  }
  if (looksNumeric(last)) return last;
  return null;
}

function stripTrailingAmount(text: string, token: string): string {
  const trimmed = text.trim();
  if (trimmed.endsWith(token)) {
    return trimmed.slice(0, -token.length).trim();
  }
  return stripTrailingToken(trimmed);
}

function stripTrailingToken(text: string): string {
  return text.trim().replace(/\S+$/u, '').trim();
}

/** Digits with separators: money-shaped, whether or not it is readable money. */
function looksNumeric(token: string): boolean {
  const compact = token.replace(/\s*([.,])\s*/gu, '$1');
  if (isMoneyToken(compact)) return true;
  // A long unbroken digit run is a product code (a UPC or SKU), not an amount.
  if (/^[-$]?\d{6,}-?$/u.test(compact)) return false;
  return /^[-$]?\d[\d.,]*\d-?(?:\s*[PTFN])?$/u.test(compact);
}

/** Whether a line is nothing but an amount, with no printed label. */
function isAmountOnlyLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return trailingAmount(trimmed) === trimmed;
}

/** Whitespace-collapse printed text: one space between tokens, no edges. */
export function collapse(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}
