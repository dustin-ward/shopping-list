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
 * Group lines into printed rows by vertical overlap: boxes that share a printed
 * row (a name and its amount, or a name and its wrapped continuation on the
 * same visual row) become one row.
 */
export function groupRows(lines: OcrLine[]): LayoutRow[] {
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
  for (const row of rows) {
    row.lines.sort((a, b) => a.box[0] - b.box[0]);
    row.box = mergeBox(row.lines[0]!.box, row.lines.at(-1)!.box);
  }
  return rows;
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
 */
export function detectPriceColumns(rows: LayoutRow[]): {
  columns: PriceColumn[];
  found: boolean;
} {
  const edges = rows
    .map((row) => trailingMoney(row)?.box[2])
    .filter((edge): edge is number => edge !== undefined)
    .sort((a, b) => a - b);
  if (edges.length === 0) return { columns: [], found: false };

  const tolerance = Math.max(4, 0.02 * (edges.at(-1) ?? 0));
  const clusters: number[][] = [];
  for (const edge of edges) {
    const current = clusters.at(-1);
    if (current && edge - (current.at(-1) ?? edge) <= tolerance)
      current.push(edge);
    else clusters.push([edge]);
  }

  const columns = clusters
    .filter((cluster) => cluster.length >= 2)
    .map((cluster) => ({
      rightEdge: cluster.reduce((sum, edge) => sum + edge, 0) / cluster.length,
      tolerance,
    }))
    .sort((a, b) => a.rightEdge - b.rightEdge);
  return { columns, found: columns.length > 0 };
}

/** Split a row into its printed text and its amount, if it carries one. */
export function splitRowPrice(
  row: LayoutRow,
  columns: PriceColumn[],
  requireColumn: boolean,
): RowPrice {
  const line = trailingMoney(row)?.line;
  const text = row.lines.map(({ text: value }) => value).join(' ');
  if (!line)
    return { text: collapse(text), priceToken: null, priceMinor: null };

  const token = trailingToken(line.text);
  const priceMinor = parseMoneyMinor(token);
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
      value === line.text ? stripTrailingToken(value) : value,
    )
    .join(' ');
  return {
    text: collapse(withoutAmount),
    priceToken: token,
    priceMinor,
  };
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
  const token = trailingToken(line.text);
  if (!token || !looksNumeric(token)) return null;
  return { line, token, minor: parseMoneyMinor(token), box: line.box };
}

function trailingToken(text: string): string {
  const tokens = text.trim().split(/\s+/u);
  return tokens.at(-1) ?? '';
}

function stripTrailingToken(text: string): string {
  return text.trim().replace(/\S+$/u, '').trim();
}

/** Digits with separators: money-shaped, whether or not it is readable money. */
function looksNumeric(token: string): boolean {
  return /^[-$]?\d[\d.,]*\d-?$/u.test(token) || isMoneyToken(token);
}

/** Whitespace-collapse printed text: one space between tokens, no edges. */
export function collapse(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}
