/**
 * What one repair of a committed line means, as pure data (ticket 16; plan §13
 * "R2 — matching maturity": committed-receipt repair flows).
 *
 * A repair resolves the same two halves a review edit has — the line's state and
 * its binding — with the rules review already uses (`resolveLineEdit`), and adds
 * the two consequences only a committed line has:
 *
 * - **The alias this line taught is retracted.** The printed text the line
 *   taught as an alias stops binding when the repair points somewhere else (or
 *   releases the line): this line's review is the only evidence for that alias,
 *   and the reviewer has just said the wording means something else. Soft
 *   deletion keeps it queryable as audit (`ADR 0003`), and an alias another line
 *   or a human confirmed is left alone — so a genuine conflict still stops
 *   matching from auto-binding instead of retargeting it in silence.
 * - **The repaired binding teaches its printed text**, exactly as a commit does,
 *   which is what makes the correction stick: the next receipt printing this
 *   wording binds where the reviewer said it belongs.
 *
 * A repair never decides anything about `raw_text`, `display_name`, `ocr_json`
 * or the image: only the binding moves.
 */

import type { RepairLinePatch, ReceiptLine } from '../../shared/schemas';
import { normalizeName } from '../../shared/normalize';
import { resolveLineEdit, type EditableLine } from './review-edits';

/** A stored line as repair reads it: the editable fields, plus the id to write back. */
export type RepairableLine = EditableLine & { id: string };

/** A live alias one line taught; the repair decides whether it stops binding. */
export type LineAlias = { id: string; catalogItemId: string };

export type LineRepair = Pick<
  ReceiptLine,
  'reviewState' | 'catalogItemId' | 'boundVia' | 'boundRank'
> & {
  lineId: string;
  /** The alias rows this line taught that the repair stops backing. */
  retractAliasIds: string[];
  /** The alias the repaired binding teaches; `null` when the line holds no item. */
  learnAlias: { aliasText: string; normalizedAlias: string } | null;
};

/**
 * Settle one committed line's repair against what is stored. The patch is
 * resolved exactly as a review edit is, so a bound line keeps an item to bind to
 * and a released one carries no binding and no provenance.
 *
 * The schema admits only `bound`, `unknown` and `skipped`, and `resolveLineEdit`
 * refuses a binding state that carries no item, so a repair can never hand a
 * committed line back to `unreviewed`.
 */
export function planLineRepair(
  line: RepairableLine,
  patch: RepairLinePatch,
  aliases: readonly LineAlias[],
): LineRepair {
  const resolved = resolveLineEdit(line, patch);
  const aliasText = line.rawText.trim();
  const normalizedAlias = normalizeName(aliasText);

  return {
    lineId: line.id,
    reviewState: resolved.reviewState,
    catalogItemId: resolved.catalogItemId,
    boundVia: resolved.boundVia,
    boundRank: resolved.boundRank,
    retractAliasIds: aliases
      .filter((alias) => alias.catalogItemId !== resolved.catalogItemId)
      .map((alias) => alias.id),
    learnAlias:
      resolved.catalogItemId && normalizedAlias
        ? { aliasText, normalizedAlias }
        : null,
  };
}
