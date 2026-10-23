/**
 * The review-state vocabulary both halves of the editor share: the labels the
 * reviewer reads and the toggle rule behind the state controls.
 *
 * A line's review state is what the commit gate asks about — every item line
 * must leave `unreviewed` — so the transitions are kept here as one small,
 * tested rule rather than re-derived in the component.
 */

import type { ReceiptReviewState } from './schemas';

/** The two states a reviewer can reach without choosing an item. */
export type ReviewStateAction = 'unknown' | 'skipped';

/** What each state is called on screen. */
export const REVIEW_STATE_LABELS: Record<ReceiptReviewState, string> = {
  unreviewed: 'Unreviewed',
  bound: 'Bound',
  new: 'New item',
  unknown: 'Unknown',
  skipped: 'Skipped',
};

/**
 * Pressing a state control toggles it: pressing the line's current state again
 * releases it back to `unreviewed`, and pressing the other state switches
 * directly, losing nothing but the previous choice.
 */
export function nextReviewState(
  current: ReceiptReviewState,
  action: ReviewStateAction,
): ReceiptReviewState {
  return current === action ? 'unreviewed' : action;
}

/**
 * Whether a state holds a catalog item. Only `bound` does: `new` is a draft
 * until commit materializes it, and `unknown`/`skipped`/`unreviewed` lines
 * carry no binding — the server clears it on the way out.
 */
export function reviewStateKeepsBinding(state: ReceiptReviewState): boolean {
  return state === 'bound';
}
