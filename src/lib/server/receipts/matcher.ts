/**
 * The deterministic matcher (plan §7). Printed name in, candidates out — no
 * model, no embeddings, no network:
 *
 * 1. **Tier 1** — the normalized printed name equals a catalog item's
 *    normalized name, or a human-confirmed alias's `normalized_alias`. Exactly
 *    one such item means the line arrives bound (`bound_via='auto'`); two or
 *    more means the phrase is ambiguous (`GLOSSARY.md`, ADR 0003) and the line
 *    is left for the reviewer with both candidates offered.
 * 2. **Tier 2** — token-set Jaccard ≥ 0.6 and Jaro-Winkler ≥ 0.85 on the
 *    normalized forms, ranked by a mix of the two, minus a penalty for unit
 *    words and size-like digits the candidate does not share, plus a boost for
 *    an item already confirmed at this store. Never bound.
 *
 * Packaging tokens (`2%`, `1l`, `oz`) are dropped from the Jaccard token sets
 * before comparing, because brand, size and packaging wording is exactly what
 * varies between two printings of the same household item; they still cost a
 * penalty when the candidate does not carry them, which is what keeps "Milk 2%"
 * ranked above plain "Milk" for a printed "MILK 2% 1L". The Jaccard and
 * Jaro-Winkler gates themselves are the plan's numbers and are deliberately
 * conservative: a wrong silent bind corrupts price history, so anything the
 * scorer is unsure of stays a tap away in tier 3 (search).
 */

import { normalizeName } from '../../shared/normalize';
import type { AmbiguousPhrase, ReceiptSuggestion } from '../../shared/schemas';

/** Most suggestions a line is ever offered; the ranking is truncated to this. */
export const MAX_SUGGESTIONS = 5;

/** Fuzzy eligibility, both gates (plan §7: Jaccard ≥ 0.6, Jaro-Winkler ≥ 0.85). */
const MIN_JACCARD = 0.6;
const MIN_JARO_WINKLER = 0.85;

/** An item already confirmed at this store outranks a marginally closer string. */
const SAME_STORE_BOOST = 0.1;

/** The ranking score mixes token overlap and edit distance evenly. */
const JACCARD_WEIGHT = 0.5;
const JARO_WINKLER_WEIGHT = 0.5;

/** Each unmatched packaging token costs this much, three of them is the cap. */
const PACKAGING_TOKEN_PENALTY = 0.05;
const MAX_PACKAGING_PENALTY = 0.15;

/**
 * Unit words and count words: the plan's list (LB, KG, OZ, PK, GAL, CT) plus the
 * canonical units the parser already normalizes to, which a receipt prints just
 * as often ("2.15LB", "1L", "12PK").
 */
const UNIT_WORDS = new Set([
  'lb',
  'lbs',
  'oz',
  'kg',
  'kgs',
  'g',
  'gr',
  'gram',
  'grams',
  'ml',
  'l',
  'lt',
  'ltr',
  'liter',
  'litre',
  'pk',
  'pks',
  'pack',
  'packs',
  'gal',
  'gals',
  'gallon',
  'ct',
  'cts',
  'count',
  'ea',
  'each',
  'dz',
  'doz',
  'dozen',
]);

export type MatcherItem = {
  catalogItemId: string;
  /** The catalog item's household name, for the chip. */
  name: string;
  normalizedName: string;
  /** A human-confirmed alias for this item was learned at this receipt's store. */
  sameStore: boolean;
};

/** A live alias a human confirmed (`source` manual or review); OCR-only aliases never match. */
export type MatcherAlias = {
  catalogItemId: string;
  /** The printed variant, for display only; matching reads the normalized form. */
  aliasText: string;
  normalizedAlias: string;
};

export type MatchContext = {
  items: MatcherItem[];
  aliases: MatcherAlias[];
};

export type LineMatch = {
  /** The item to bind now, or `null` when nothing — or more than one thing — matches. */
  bind: string | null;
  /** Ranked candidates, ≤ `MAX_SUGGESTIONS`; empty for a parked row or no match. */
  suggestions: ReceiptSuggestion[];
};

/** The fields matching needs from a receipt line. */
export type MatchableLine = {
  parsedName: string | null;
  rawText: string;
};

/** A line whose suggestions are wanted; `id` keys the result. */
export type MatchableReceiptLine = MatchableLine & {
  id: string;
  isItemChunk: boolean;
};

/**
 * Match one printed phrase against the list's items and confirmed aliases.
 * The one entry point: the worker binds what it returns an item for, and the
 * receipt detail serves what it returns as candidates.
 */
export function matchReceiptLine(
  phrase: string,
  context: MatchContext,
): LineMatch {
  const normalized = normalizeName(phrase);
  if (!normalized) return { bind: null, suggestions: [] };

  const tierOne = tierOneCandidates(normalized, context);
  if (tierOne.length > 0) {
    return {
      // Ambiguity guard: one phrase mapping to two items asks instead of choosing.
      bind: tierOne.length === 1 ? tierOne[0]!.catalogItemId : null,
      suggestions: tierOne.slice(0, MAX_SUGGESTIONS),
    };
  }

  return { bind: null, suggestions: rankByScore(normalized, context.items) };
}

/** Where a phrase comes from: the parser's name read, else the printed text. */
export function phraseForLine(line: MatchableLine): string {
  return line.parsedName?.trim() || line.rawText;
}

/**
 * Every phrase the list cannot resolve: two or more items claim it — one by its
 * household name, the other by a human-confirmed alias — so tier 1 refuses to
 * bind and the reviewer is asked instead of guessed at (`ADR 0003`).
 *
 * This is the same decision `matchReceiptLine` makes, surfaced for the reviewer:
 * the claims are the evidence matching itself reads and the candidates come from
 * the same tier-1 rule, so the list cannot drift from what a line actually does.
 * Ordered by normalized phrase, claimants in the matcher's own candidate order.
 */
export function ambiguousPhrases(context: MatchContext): AmbiguousPhrase[] {
  const display = new Map<string, string>();
  for (const claim of claimPhrases(context)) {
    if (!display.has(claim.normalized)) {
      display.set(claim.normalized, claim.text);
    }
  }

  const ambiguous: AmbiguousPhrase[] = [];
  for (const [normalizedPhrase, phrase] of display) {
    const claiming = tierOneCandidates(normalizedPhrase, context);
    if (claiming.length < 2) continue;
    ambiguous.push({
      phrase,
      normalizedPhrase,
      items: claiming.map(({ catalogItemId, name }) => ({
        catalogItemId,
        name,
      })),
    });
  }

  return ambiguous.sort((left, right) =>
    left.normalizedPhrase.localeCompare(right.normalizedPhrase),
  );
}

/**
 * The phrases the list knows, in claim order: every item's household name first,
 * then every confirmed alias's printed text. An item name really is a claim —
 * tier 1 binds on it — which is how an item name and another item's alias can
 * end up in conflict.
 */
function claimPhrases({
  items,
  aliases,
}: MatchContext): { text: string; normalized: string }[] {
  const claims = items.map((item) => ({
    text: item.name,
    normalized: item.normalizedName,
  }));
  for (const alias of aliases) {
    if (!alias.normalizedAlias) continue;
    claims.push({
      text: alias.aliasText.trim() || alias.normalizedAlias,
      normalized: alias.normalizedAlias,
    });
  }
  return claims;
}

/**
 * Suggestions per line id, for every item line (parked rows are not bought
 * things, so they get none and are absent from the map).
 */
export function suggestionsForLines(
  lines: readonly MatchableReceiptLine[],
  context: MatchContext,
): Map<string, ReceiptSuggestion[]> {
  const byLine = new Map<string, ReceiptSuggestion[]>();
  for (const line of lines) {
    if (!line.isItemChunk) continue;
    byLine.set(
      line.id,
      matchReceiptLine(phraseForLine(line), context).suggestions,
    );
  }
  return byLine;
}

/**
 * The tier-1 candidates for a normalized phrase: an item whose normalized name
 * equals it, or one a human-confirmed alias points at. De-duplicated — the same
 * item reached both ways is one candidate — and ordered by name so an ambiguous
 * phrase always offers the same two chips in the same order.
 */
function tierOneCandidates(
  normalized: string,
  { items, aliases }: MatchContext,
): ReceiptSuggestion[] {
  const matched = new Map<string, MatcherItem>();
  for (const item of items) {
    if (item.normalizedName === normalized)
      matched.set(item.catalogItemId, item);
  }
  const byId = new Map(items.map((item) => [item.catalogItemId, item]));
  for (const alias of aliases) {
    if (alias.normalizedAlias !== normalized) continue;
    const item = byId.get(alias.catalogItemId);
    if (item) matched.set(item.catalogItemId, item);
  }

  return [...matched.values()]
    .sort(
      (left, right) =>
        left.normalizedName.localeCompare(right.normalizedName) ||
        left.catalogItemId.localeCompare(right.catalogItemId),
    )
    .map((item) => toSuggestion(item, 1, 1));
}

/** Fuzzy candidates that clear both gates, best first, capped at five. */
function rankByScore(
  normalized: string,
  items: readonly MatcherItem[],
): ReceiptSuggestion[] {
  return items
    .map((item) => ({ item, score: scorePair(normalized, item) }))
    .filter(({ score }) => score !== null)
    .sort(
      (left, right) =>
        right.score! - left.score! ||
        left.item.normalizedName.localeCompare(right.item.normalizedName) ||
        left.item.catalogItemId.localeCompare(right.item.catalogItemId),
    )
    .slice(0, MAX_SUGGESTIONS)
    .map(({ item, score }) => toSuggestion(item, 2, score!));
}

/** One candidate as it travels to the client, whichever tier found it. */
function toSuggestion(
  item: MatcherItem,
  tier: ReceiptSuggestion['tier'],
  score: number,
): ReceiptSuggestion {
  return {
    catalogItemId: item.catalogItemId,
    name: item.name,
    tier,
    score,
    sameStore: item.sameStore,
  };
}

/**
 * One candidate's ranking score, or `null` when it does not clear the gates.
 * The gates are the plan's: significant-token Jaccard ≥ 0.6 and Jaro-Winkler
 * ≥ 0.85 between the normalized forms.
 */
function scorePair(normalized: string, item: MatcherItem): number | null {
  const phraseTokens = tokenize(normalized);
  const itemTokens = tokenize(item.normalizedName);
  const jaccard = significantJaccard(phraseTokens, itemTokens);
  const similarity = jaroWinkler(normalized, item.normalizedName);
  if (jaccard < MIN_JACCARD || similarity < MIN_JARO_WINKLER) return null;

  const score =
    JACCARD_WEIGHT * jaccard +
    JARO_WINKLER_WEIGHT * similarity -
    packagingPenalty(phraseTokens, itemTokens) +
    (item.sameStore ? SAME_STORE_BOOST : 0);
  return round4(score);
}

function tokenize(normalized: string): string[] {
  return normalized.split(' ').filter(Boolean);
}

function significantTokens(tokens: readonly string[]): string[] {
  return tokens.filter((token) => !isPackagingToken(token));
}

/**
 * Jaccard over the tokens that carry identity. A phrase that is packaging
 * alone ("2 LB") has nothing to compare, and never suggests anything: `0` keeps
 * it ineligible rather than letting an empty set match everything.
 */
function significantJaccard(
  left: readonly string[],
  right: readonly string[],
): number {
  const leftSet = new Set(significantTokens(left));
  const rightSet = new Set(significantTokens(right));
  if (leftSet.size === 0 || rightSet.size === 0) return 0;

  let shared = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) shared += 1;
  }
  return shared / (leftSet.size + rightSet.size - shared);
}

/**
 * How much the two phrases disagree about packaging: unit words and size-like
 * digits that only one of them carries. Capped, so one long printed variant
 * cannot bury an otherwise good candidate.
 */
function packagingPenalty(
  left: readonly string[],
  right: readonly string[],
): number {
  const leftOnly = unmatchedTokens(left, right);
  const rightOnly = unmatchedTokens(right, left);
  const count = [...leftOnly, ...rightOnly].filter(isPackagingToken).length;
  return (
    Math.min(count, MAX_PACKAGING_PENALTY / PACKAGING_TOKEN_PENALTY) *
    PACKAGING_TOKEN_PENALTY
  );
}

function unmatchedTokens(
  tokens: readonly string[],
  other: readonly string[],
): Set<string> {
  const otherSet = new Set(other);
  return new Set(tokens.filter((token) => !otherSet.has(token)));
}

/** `2%`, `1l`, `80z`: a token that contains a digit is a size, not a name. */
function isPackagingToken(token: string): boolean {
  return UNIT_WORDS.has(token) || /\d/u.test(token);
}

/**
 * Jaro-Winkler similarity between two strings (0..1). The classic definition:
 * matches fall within a window of half the longer length, transpositions are
 * counted over the matched characters, and up to four shared prefix characters
 * are rewarded.
 */
export function jaroWinkler(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length === 0 || right.length === 0) return 0;

  const window = Math.max(
    0,
    Math.floor(Math.max(left.length, right.length) / 2) - 1,
  );
  const leftMatches = new Array<boolean>(left.length).fill(false);
  const rightMatches = new Array<boolean>(right.length).fill(false);

  let matches = 0;
  for (let i = 0; i < left.length; i += 1) {
    const start = Math.max(0, i - window);
    const end = Math.min(right.length - 1, i + window);
    for (let j = start; j <= end; j += 1) {
      if (rightMatches[j] || left[i] !== right[j]) continue;
      leftMatches[i] = true;
      rightMatches[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let cursor = 0;
  for (let i = 0; i < left.length; i += 1) {
    if (!leftMatches[i]) continue;
    while (!rightMatches[cursor]) cursor += 1;
    if (left[i] !== right[cursor]) transpositions += 1;
    cursor += 1;
  }
  transpositions /= 2;

  const jaro =
    (matches / left.length +
      matches / right.length +
      (matches - transpositions) / matches) /
    3;

  let prefix = 0;
  const maxPrefix = Math.min(4, left.length, right.length);
  while (prefix < maxPrefix && left[prefix] === right[prefix]) prefix += 1;

  return jaro + prefix * 0.1 * (1 - jaro);
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}
