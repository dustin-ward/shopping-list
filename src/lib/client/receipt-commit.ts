/**
 * The commit and discard client half (plan §5, §8): what the reviewer's drafts
 * add up to when they are sent, whether the gate would let them send it at all,
 * and one reader-facing sentence per refusal.
 *
 * The gate is stated twice on purpose. The server's plan is the authority — a
 * commit that fails it writes nothing — while this half is what keeps the button
 * disabled and says *why* before a request is made. Both ask the same question:
 * every item line has left `unreviewed`, and a store is set (the totals delta
 * never gates). The drafts travel here and only here: a name the reviewer gave
 * an inline-created item and a drafted store name live in the editor, never in a
 * row, until this request materializes them.
 */

import { ApiError, requestJson } from './api';
import { itemDraftName } from './receipt-binding';
import type {
  CommitReceiptInput,
  ReceiptDetail,
  ReceiptDetailLine,
} from '../shared/schemas';

/** The reviewer's inline drafts, exactly as the editor holds them. */
export type CommitDrafts = {
  /** Names the reviewer gave item lines they created inline, by line id. */
  itemDrafts: Readonly<Record<string, string>>;
  /** A store name the reviewer typed instead of choosing a group. */
  storeDraft: string;
};

/** The one thing a reader needs from a receipt before it can be committed. */
type CommittableReceipt = Pick<
  ReceiptDetail,
  'status' | 'lines' | 'storeGroupId'
>;

/**
 * Why the receipt cannot be committed yet, or `null` when it can. Every item
 * line must have left `unreviewed` (parked rows are parser-settled and never
 * gate) and a store must be set — either a chosen group or a name the reviewer
 * drafted. A large totals delta is a warning, never a blocker.
 */
export function commitBlocker(
  detail: CommittableReceipt,
  drafts: CommitDrafts,
): string | null {
  if (detail.status !== 'review') {
    return 'Only a receipt in review can be committed.';
  }

  const undecided = detail.lines.filter(
    (line) => line.isItemChunk && line.reviewState === 'unreviewed',
  ).length;
  if (undecided === 1) {
    return 'One item line still needs a decision (bind it, mark it unknown, or skip it).';
  }
  if (undecided > 1) {
    return `${undecided} item lines still need a decision (bind them, mark them unknown, or skip them).`;
  }

  if (!detail.storeGroupId && !drafts.storeDraft.trim()) {
    return 'Choose or name the store before committing.';
  }
  return null;
}

/**
 * The drafts the payload carries: one name per line that is creating an item.
 * A line the reviewer never renamed sends the name the picker showed it — the
 * parser's — so a draft always names something, exactly as it does on screen.
 */
export function commitItemDrafts(
  lines: readonly Pick<
    ReceiptDetailLine,
    'id' | 'isItemChunk' | 'reviewState' | 'parsedName' | 'rawText'
  >[],
  drafts: Readonly<Record<string, string>>,
): { lineId: string; name: string }[] {
  return lines
    .filter((line) => line.isItemChunk && line.reviewState === 'new')
    .map((line) => ({
      lineId: line.id,
      name: (drafts[line.id] ?? '').trim() || itemDraftName(line),
    }))
    .filter((draft) => draft.name.length > 0);
}

/**
 * The commit request: the reviewer's drafts plus the `updatedAt` the editor last
 * saw, the same guard every review edit carries. A chosen group and a drafted
 * name are two spellings of one answer, so the group wins if both somehow stand
 * — the server refuses the pair rather than guess.
 */
export function commitReceiptInput(
  detail: CommittableReceipt & Pick<ReceiptDetail, 'id' | 'updatedAt'>,
  drafts: CommitDrafts,
): CommitReceiptInput {
  const itemDrafts = commitItemDrafts(detail.lines, drafts.itemDrafts);
  const storeDraft = detail.storeGroupId ? '' : drafts.storeDraft.trim();

  return {
    expectedUpdatedAt: detail.updatedAt,
    ...(itemDrafts.length ? { itemDrafts } : {}),
    ...(storeDraft ? { storeDraft } : {}),
  };
}

/** Commit one reviewed receipt; the server answers with the committed detail. */
export function submitReceiptCommit(
  receiptId: string,
  input: CommitReceiptInput,
): Promise<ReceiptDetail> {
  return requestJson<ReceiptDetail>(`/api/receipts/${receiptId}/commit`, {
    method: 'POST',
    body: input,
  });
}

/**
 * Discard one receipt. The payload is an empty object on purpose: the route
 * takes no input, and the server hook only lets a JSON content type through.
 */
export function submitReceiptDiscard(
  receiptId: string,
): Promise<ReceiptDetail> {
  return requestJson<ReceiptDetail>(`/api/receipts/${receiptId}/discard`, {
    method: 'POST',
    body: {},
  });
}

/** One sentence for every refusal a commit can meet. */
export function commitErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'The receipt could not be committed. Try again.';
  }
  switch (error.code) {
    case 'RECEIPT_NOT_REVIEWED':
      return 'Some item lines still need a decision — review them, then commit.';
    case 'RECEIPT_STORE_REQUIRED':
      return 'Choose the store this receipt is from before committing.';
    case 'RECEIPT_ALREADY_COMMITTED':
      return 'This receipt was already committed — the latest version is shown.';
    case 'RECEIPT_NOT_COMMITTABLE':
      return 'Only a receipt in review can be committed.';
    case 'RECEIPT_CHANGED':
      return 'This receipt changed on another device — review the latest version and commit again.';
    case 'GROUP_NAME_EXISTS':
      return 'A group with that store name already exists — pick it instead.';
    default:
      return error.message;
  }
}

/** One sentence for every refusal a discard can meet. */
export function discardErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'The receipt could not be discarded. Try again.';
  }
  if (error.code === 'RECEIPT_COMMITTED') {
    return 'A committed receipt cannot be discarded.';
  }
  return error.message;
}
